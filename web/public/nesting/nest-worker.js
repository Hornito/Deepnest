/*
 * Nesting worker.
 *
 * In the desktop app this job runs in a hidden Electron BrowserWindow that
 * talks over ipcRenderer and calls into a compiled C++ addon. In the browser
 * there are no hidden windows and no native code, so the same work happens
 * here in a Web Worker: the main thread runs the genetic algorithm and posts
 * one candidate ("individual") at a time; this worker evaluates it and posts
 * back a placement plus a fitness score.
 *
 * This is a classic worker, not a module worker, specifically so it can pull
 * in Deepnest's nesting core with importScripts(). That core is a set of
 * classic scripts that register themselves on the global object, and keeping
 * them byte-identical to the desktop app is worth more than module syntax.
 */

/* global ClipperLib, GeometryUtil, PlacementWorker, rotatePolygon, DeepnestNFP */

// Resolve siblings relative to this file so the app still works when deployed
// under a sub-path (project pages, a /nest/ mount, etc.) rather than a domain
// root. An absolute "/vendor/..." would break in exactly those cases.
const resolve = (rel) => new URL(rel, self.location.href).href;

importScripts(
  resolve('../vendor/util-clipper.js'),
  resolve('../vendor/util-matrix.js'),
  resolve('../vendor/util-geometryutil.js'),
  resolve('../vendor/util-placementworker.js'),
  resolve('./nfp.js')
);

// placementworker.js reaches for `global.env.self` to find the worker instance
// it should read binPolygon/nfpCache off. parallel.js used to provide that
// ambient object; we provide it directly.
self.global = { env: {} };

/*
 * NFP cache.
 *
 * Computing a no-fit polygon is by far the most expensive thing here, and the
 * genetic algorithm re-tries the same shape pairs constantly across
 * generations. Caching them per shape-pair-and-rotation is what makes the
 * whole approach viable.
 *
 * Keyed by SOURCE id, not by the placement instance. Ten copies of a bracket
 * are ten instances with ten distinct ids but a single source, and every pair
 * of them has the same no-fit polygon - so ten copies cost one NFP rather than
 * the forty-five that pairing each instance with every other would.
 *
 * placePaths still looks NFPs up by instance id, because that is the key it
 * builds; evaluate() maps those lookups onto the shared entries.
 */
const nfpCache = new Map();

// The sheet is not a part and carries no source of its own.
const BIN_SOURCE = -1;

// Bounded so a long-running nest of many distinct parts cannot grow the cache
// until the tab is killed. Overridable so the tests can drive the eviction path
// without first allocating twenty thousand no-fit polygons.
const NFP_CACHE_LIMIT = self.NFP_CACHE_LIMIT || 20000;

// Bumped once per evaluation. Entries the evaluation in flight has touched
// carry the current epoch, which is what keeps pruneCache off them.
let epoch = 0;

// Instances carry a source; anything without one is its own source.
function sourceOf(polygon) {
  return polygon.source === undefined || polygon.source === null
    ? polygon.id
    : polygon.source;
}

function cacheKey(aSource, bSource, inside, aRotation, bRotation) {
  return `${aSource}/${bSource}/${inside ? 1 : 0}/${aRotation}/${bRotation}`;
}

function cacheGet(key) {
  const entry = nfpCache.get(key);
  if (entry === undefined) {
    return undefined;
  }
  // Touch it: the current evaluation needs this one, so it has to survive.
  entry.epoch = epoch;
  return entry.value;
}

function cacheSet(key, value) {
  nfpCache.set(key, { value: value, epoch: epoch });
}

/*
 * Drop entries left over from earlier evaluations.
 *
 * Only those may go. Evicting an entry the current evaluation still needs does
 * not merely cost time: placePaths looks the NFP up, misses, and skips that
 * part altogether - so it vanishes from the nest with no error raised
 * anywhere. Briefly exceeding the limit is much the better failure.
 */
function pruneCache() {
  if (nfpCache.size <= NFP_CACHE_LIMIT) {
    return;
  }
  for (const [key, entry] of nfpCache) {
    if (entry.epoch !== epoch) {
      nfpCache.delete(key);
    }
  }
}

/*
 * Compute the no-fit polygon for one pair.
 *
 * `inside` is the part-in-sheet case (where may this part sit within the
 * sheet), everything else is the part-against-part case (where may this part
 * sit without hitting one already placed).
 */
function computeNfp(pair, searchEdges, useHoles) {
  const A = rotatePolygon(pair.A, pair.Arotation);
  const B = rotatePolygon(pair.B, pair.Brotation);

  if (pair.inside) {
    // Sheets are rectangles in every material-driven nest, which
    // calculateNFP detects and answers in closed form.
    const nfp = DeepnestNFP.calculateNFP({
      A,
      B,
      inside: true,
      searchEdges,
    });

    if (!nfp || nfp.length === 0) {
      // Not an error: the part is simply too big for the sheet.
      return null;
    }

    // An inner NFP with no area is unusable - it would collapse placement to
    // a point that the clipper union later discards anyway.
    return nfp.filter((n) => n && n.length > 2);
  }

  const nfp = DeepnestNFP.calculateNFP({
    A,
    B,
    inside: false,
    searchEdges,
  });

  if (!nfp || nfp.length === 0) {
    return null;
  }

  const result = nfp.filter((n) => n && n.length > 2);
  if (result.length === 0) {
    return null;
  }

  // Holes are only usable when the caller asked for part-in-part nesting.
  // Dropping them here keeps the placement worker from discovering interior
  // positions the user did not opt into.
  if (!useHoles) {
    for (const ring of result) {
      ring.children = [];
    }
  }

  return result;
}

/*
 * Rebuild the array-with-properties polygon the geometry core expects.
 *
 * The main thread sends {points, id, source, rotation, children} because a
 * bare array loses its extra properties in structured clone. Everything below
 * this line works with the native form again.
 */
function deserialize(obj) {
  if (!obj) {
    return null;
  }
  const polygon = obj.points.map((p) => ({ x: p.x, y: p.y }));
  polygon.id = obj.id;
  polygon.source = obj.source;
  polygon.rotation = obj.rotation;
  polygon.children = (obj.children || []).map(deserialize).filter(Boolean);
  return polygon;
}

/*
 * Evaluate one GA individual: build every NFP its placement order needs, then
 * hand the whole thing to Deepnest's placement worker.
 */
function evaluate(data) {
  const { index, individual, config, sheets } = data;

  epoch++;

  const placelist = individual.placement.map(deserialize);
  const rotations = individual.rotation;

  const ids = [];
  for (let i = 0; i < placelist.length; i++) {
    ids.push(placelist[i].id);
    placelist[i].rotation = rotations[i];
  }

  // The sheet is the "bin". Its id is pinned to -1 because placementworker.js
  // hardcodes that value when it looks up the part-in-sheet NFP.
  const binPolygon = deserialize(sheets[0]);
  binPolygon.id = -1;

  const searchEdges = !!config.exploreConcave;
  const useHoles = !!config.useHoles;

  /*
   * Work out what geometry this candidate needs.
   *
   * Two lists come out of it, because two different things are being keyed:
   *
   *   - `pending` is the NFPs still to compute, one per distinct SOURCE pair.
   *     Copies of one part collapse into a single entry here.
   *   - `plan` is every lookup placePaths will make, one per placement
   *     INSTANCE pair, each pointing at the shared cache entry that answers it.
   *
   * Order matters: a part is only ever tested against parts placed before it.
   */
  const pending = [];
  const queued = new Set();
  const plan = [];

  for (let i = 0; i < placelist.length; i++) {
    const part = placelist[i];
    const partSource = sourceOf(part);

    const binKey = cacheKey(BIN_SOURCE, partSource, true, 0, rotations[i]);
    plan.push({
      lookup: JSON.stringify({
        A: -1,
        B: part.id,
        inside: true,
        Arotation: 0,
        Brotation: rotations[i],
      }),
      key: binKey,
    });

    if (cacheGet(binKey) === undefined && !queued.has(binKey)) {
      queued.add(binKey);
      pending.push({
        A: binPolygon,
        B: part,
        key: binKey,
        inside: true,
        Arotation: 0,
        Brotation: rotations[i],
      });
    }

    for (let j = 0; j < i; j++) {
      const placed = placelist[j];
      const pairKey = cacheKey(
        sourceOf(placed),
        partSource,
        false,
        rotations[j],
        rotations[i]
      );

      plan.push({
        lookup: JSON.stringify({
          A: placed.id,
          B: part.id,
          inside: false,
          Arotation: rotations[j],
          Brotation: rotations[i],
        }),
        key: pairKey,
      });

      if (cacheGet(pairKey) === undefined && !queued.has(pairKey)) {
        queued.add(pairKey);
        pending.push({
          A: placed,
          B: part,
          key: pairKey,
          inside: false,
          Arotation: rotations[j],
          Brotation: rotations[i],
        });
      }
    }
  }

  // Compute the missing ones, reporting progress as we go. This loop is the
  // bulk of the runtime, so progress here is what the user actually sees.
  for (let i = 0; i < pending.length; i++) {
    const pair = pending[i];
    let value = null;
    try {
      value = computeNfp(pair, searchEdges, useHoles);
    } catch (err) {
      // A single bad pair must not sink the whole nest. Cache the failure as
      // null so we do not retry it every generation.
      value = null;
    }
    cacheSet(pair.key, value);

    if (i % 25 === 0) {
      self.postMessage({
        type: 'progress',
        index,
        progress: 0.9 * (i / pending.length),
      });
    }
  }

  // placePaths reads the cache with JSON.stringify'd instance keys, so hand it
  // a plain object in that shape. Every instance pair that shares a source
  // points at the same NFP; placePaths only ever reads them, so the sharing is
  // safe as well as free.
  const cacheForPlacement = {};
  for (const entry of plan) {
    const nfp = cacheGet(entry.key);
    if (nfp) {
      cacheForPlacement[entry.lookup] = nfp;
    }
  }

  const worker = new PlacementWorker(
    binPolygon,
    placelist.slice(0),
    ids,
    rotations,
    config,
    cacheForPlacement
  );

  self.global.env.self = worker;

  const placement = worker.placePaths(placelist.slice(0));

  // Now that nothing is reading the cache, entries from earlier candidates can
  // go if we are over budget.
  pruneCache();

  self.postMessage({ type: 'progress', index, progress: 1 });

  return placement;
}

self.onmessage = (event) => {
  const data = event.data;

  if (data.type !== 'nest') {
    return;
  }

  try {
    const placement = evaluate(data);
    self.postMessage({
      type: 'result',
      index: data.index,
      placement,
    });
  } catch (err) {
    self.postMessage({
      type: 'error',
      index: data.index,
      message: err && err.message ? err.message : String(err),
      stack: err && err.stack ? err.stack : null,
    });
  }
};
