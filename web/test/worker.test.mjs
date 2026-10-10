/*
 * Tests for the nesting worker itself.
 *
 * The NFP computation dominates the runtime of a nest, so what matters most
 * about the worker is not just that it returns a valid placement but HOW MUCH
 * geometry it computes to get there. A nest of 50 identical brackets should
 * cost about the same as a nest of one; if it does not, the cache is keyed
 * wrongly and the app crawls on exactly the workloads it is built for.
 *
 * That cost is invisible in the output - a wrongly keyed cache still nests
 * correctly, just far too slowly - so these tests boot the real worker in a vm
 * (real ClipperLib, real GeometryUtil, real PlacementWorker) and count the
 * calls into calculateNFP.
 *
 * Run with: npm test
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const nesting = join(here, '..', 'public', 'nesting');

/*
 * Boot nest-worker.js the way a browser would.
 *
 * The worker resolves its dependencies relative to its own location and pulls
 * them in with importScripts(), so the sandbox provides both: a `location` to
 * resolve against and an importScripts that actually loads the file.
 */
function bootWorker(options = {}) {
  const sandbox = {
    navigator: { userAgent: 'node', appName: 'Netscape' },
    console,
    URL,
    location: { href: `file://${join(nesting, 'nest-worker.js')}` },
    messages: [],
    NFP_CACHE_LIMIT: options.cacheLimit,
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.postMessage = (data) => sandbox.messages.push(data);

  const context = createContext(sandbox);

  sandbox.importScripts = (...urls) => {
    for (const url of urls) {
      const file = resolvePath(nesting, fileURLToPath(url));
      runInContext(readFileSync(file, 'utf8'), context, { filename: file });
    }
  };

  const worker = join(nesting, 'nest-worker.js');
  runInContext(readFileSync(worker, 'utf8'), context, { filename: worker });

  // Count the expensive calls. computeNfp reaches for the global DeepnestNFP
  // on every call, so replacing the method here is enough to see them all.
  const real = sandbox.DeepnestNFP.calculateNFP;
  sandbox.nfpCalls = 0;
  sandbox.DeepnestNFP.calculateNFP = (args) => {
    sandbox.nfpCalls++;
    return real(args);
  };

  return sandbox;
}

const rect = (w, h) => [
  { x: 0, y: 0 },
  { x: w, y: 0 },
  { x: w, y: h },
  { x: 0, y: h },
];

const serialize = (points, id, source) => ({
  points,
  id,
  source,
  rotation: 0,
  children: [],
});

const CONFIG = {
  clipperScale: 10000000,
  curveTolerance: 0.3,
  spacing: 0,
  rotations: 4,
  useHoles: false,
  exploreConcave: false,
};

/* Drive one nest through the worker and hand back what it cost. */
function nest(parts, options = {}) {
  const sandbox = bootWorker(options);

  sandbox.onmessage({
    data: {
      type: 'nest',
      index: 0,
      individual: {
        placement: parts,
        rotation: parts.map(() => 0),
      },
      config: CONFIG,
      sheets: [serialize(rect(200, 200), -1, -1)],
    },
  });

  const failure = sandbox.messages.find((m) => m.type === 'error');
  assert.equal(failure, undefined, `worker errored: ${failure?.message}`);

  const result = sandbox.messages.find((m) => m.type === 'result');
  assert.ok(result, 'worker returned no result');

  const placed = result.placement.placements.reduce((n, s) => n + s.length, 0);
  return { placement: result.placement, placed, nfpCalls: sandbox.nfpCalls };
}

test('identical parts share one NFP instead of one per pair', () => {
  // Eight copies of one square. Every pair of them has the same no-fit
  // polygon, so the worker should compute two: the part-in-sheet NFP and the
  // part-against-part NFP.
  //
  // Keying the cache by placement instance instead of by source makes this
  // 8 bin NFPs + 8*7/2 pair NFPs = 36 - the quadratic blow-up this cache
  // exists to prevent.
  const copies = [];
  for (let i = 0; i < 8; i++) {
    copies.push(serialize(rect(20, 20), i, 100));
  }

  const { placement, placed, nfpCalls } = nest(copies);

  assert.ok(
    nfpCalls <= 4,
    `expected a handful of NFP computations for 8 identical parts, got ${nfpCalls}`
  );

  // The dedup must not cost placements: all eight still land on one sheet.
  assert.equal(placement.placements.length, 1);
  assert.equal(placed, 8);
});

test('the saving holds as the quantity grows', () => {
  // The point of keying by source is that cost stops tracking quantity. Fifty
  // copies pair up 1,225 ways; the work must not follow.
  const copies = [];
  for (let i = 0; i < 50; i++) {
    copies.push(serialize(rect(20, 20), i, 7));
  }

  const { placed, nfpCalls } = nest(copies);

  assert.ok(
    nfpCalls <= 4,
    `50 copies should cost the same as 8, got ${nfpCalls} NFP computations`
  );
  assert.equal(placed, 50);
});

test('distinct parts still each get their own NFP', () => {
  // The counterpart to the tests above: the dedup must key off the geometry's
  // source and not simply collapse everything. Eight different squares share
  // nothing, so the work is the full 8 bin + 28 pair set.
  const parts = [];
  for (let i = 0; i < 8; i++) {
    parts.push(serialize(rect(10 + i, 10 + i), i, i));
  }

  const { placed, nfpCalls } = nest(parts);

  assert.equal(nfpCalls, 8 + (8 * 7) / 2);
  assert.equal(placed, 8);
});

test('a nest larger than the cache limit still places every part', () => {
  // The cache is bounded so a long run cannot grow until the tab dies, but
  // evicting an entry the evaluation in flight still needs is worse than the
  // memory it saves: placePaths looks the NFP up, misses, and skips the part -
  // which then vanishes from the nest with no error raised anywhere.
  //
  // 40 distinct parts need 40 + 780 = 820 entries in a single pass, against a
  // limit of 50, so any eviction mid-pass would take entries still in use.
  const parts = [];
  for (let i = 0; i < 40; i++) {
    parts.push(serialize(rect(5 + i * 0.1, 5 + i * 0.1), i, i));
  }

  const { placed } = nest(parts, { cacheLimit: 50 });

  assert.equal(placed, 40, 'every part must be placed, none silently dropped');
});
