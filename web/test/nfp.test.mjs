/*
 * Unit tests for the pure-JS no-fit-polygon core that replaces the native
 * minkowski addon.
 *
 * This is the piece the whole browser port rests on: if the NFPs are wrong,
 * parts silently overlap and the nest is scrap. So the geometry is checked
 * against closed-form answers rather than against a golden file.
 *
 * Run with: npm test
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const vendor = join(here, '..', 'public', 'vendor');
const nesting = join(here, '..', 'public', 'nesting');

// The nesting core is a set of classic browser scripts. Load them into a vm
// context that looks enough like a Web Worker for them to register: clipper.js
// probes `document` and `navigator`, and falls back to `self` when there is no
// document - exactly the worker path we use in the browser.
function loadCore() {
  const sandbox = {
    navigator: { userAgent: 'node', appName: 'Netscape' },
    console,
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  const context = createContext(sandbox);

  for (const file of [
    join(vendor, 'util-clipper.js'),
    join(vendor, 'util-geometryutil.js'),
    join(nesting, 'nfp.js'),
  ]) {
    runInContext(readFileSync(file, 'utf8'), context, { filename: file });
  }

  return sandbox;
}

const core = loadCore();
const { DeepnestNFP, GeometryUtil } = core;

const rect = (x, y, w, h) => [
  { x, y },
  { x: x + w, y },
  { x: x + w, y: y + h },
  { x, y: y + h },
];

function bounds(polygon) {
  const xs = polygon.map((p) => p.x);
  const ys = polygon.map((p) => p.y);
  return {
    x: Math.min(...xs),
    y: Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
}

const close = (a, b, tol = 1e-4) =>
  assert.ok(Math.abs(a - b) < tol, `expected ${a} to be within ${tol} of ${b}`);

test('core scripts register in a worker-like context', () => {
  assert.ok(core.ClipperLib, 'ClipperLib should be global');
  assert.ok(core.GeometryUtil, 'GeometryUtil should be global');
  assert.ok(DeepnestNFP, 'DeepnestNFP should be global');
  assert.equal(typeof core.addon.calculateNFP, 'function');
});

test('outer NFP of two rectangles is the Minkowski sum rectangle', () => {
  // A 10x10 stationary square and a 4x4 orbiting square. The locus of B's
  // reference point is a 14x14 square spanning (-4,-4)..(10,10): B's corner
  // reaches 4 units past each side of A before the two separate.
  const A = rect(0, 0, 10, 10);
  const B = rect(0, 0, 4, 4);

  const nfp = DeepnestNFP.calculateNFP({ A, B });
  assert.equal(nfp.length, 1, 'convex inputs give exactly one ring');

  const b = bounds(nfp[0]);
  close(b.width, 14);
  close(b.height, 14);
  close(b.x, -4);
  close(b.y, -4);
});

test('outer NFP is invariant to where B is drawn', () => {
  // The NFP must describe the RELATIONSHIP between two shapes, not depend on
  // the coordinates B happens to be drawn at. minkowski.cc gets this by adding
  // B[0] back to every output point, which cancels B's own origin; we do the
  // same, so a 4x4 square drawn at (100,100) must give the same NFP as one
  // drawn at (0,0). placementworker.js then subtracts the part's own first
  // point to turn an NFP vertex into a placement translation.
  const A = rect(0, 0, 10, 10);
  const atOrigin = DeepnestNFP.calculateNFP({ A, B: rect(0, 0, 4, 4) })[0];
  const faraway = DeepnestNFP.calculateNFP({ A, B: rect(100, 100, 4, 4) })[0];

  const a = bounds(atOrigin);
  const f = bounds(faraway);

  close(f.x, a.x);
  close(f.y, a.y);
  close(f.width, a.width);
  close(f.height, a.height);
  close(f.width, 14);
});

test('interior NFP of a rectangle uses the closed-form rectangle path', () => {
  // A 4x4 part inside a 10x10 sheet: its reference corner can travel over a
  // 6x6 region before the part hangs off an edge.
  const sheet = rect(0, 0, 10, 10);
  const part = rect(0, 0, 4, 4);

  const nfp = DeepnestNFP.calculateNFP({ A: sheet, B: part, inside: true });
  assert.ok(nfp.length >= 1, 'part should fit inside the sheet');

  const b = bounds(nfp[0]);
  close(b.width, 6);
  close(b.height, 6);
});

test('a part larger than the sheet yields no interior NFP', () => {
  const sheet = rect(0, 0, 10, 10);
  const part = rect(0, 0, 12, 4);

  const nfp = DeepnestNFP.calculateNFP({ A: sheet, B: part, inside: true });
  assert.equal(nfp.length, 0, 'oversized part must not be placeable');
});

test('holes of A become interior NFP children when the part fits', () => {
  // A 20x20 plate with a 10x10 window, and a 4x4 part. The part fits in the
  // window, so the outer NFP must carry one child describing where inside the
  // window the part may sit: a 6x6 region.
  const A = rect(0, 0, 20, 20);
  A.children = [rect(5, 5, 10, 10)];
  const B = rect(0, 0, 4, 4);

  const nfp = DeepnestNFP.calculateNFP({ A, B });
  assert.equal(nfp.length, 1);
  assert.equal(nfp[0].children.length, 1, 'the window should accept the part');

  const child = bounds(nfp[0].children[0]);
  close(child.width, 6);
  close(child.height, 6);
});

test('holes too small for the part are rejected', () => {
  const A = rect(0, 0, 20, 20);
  A.children = [rect(5, 5, 3, 3)];
  const B = rect(0, 0, 4, 4);

  const nfp = DeepnestNFP.calculateNFP({ A, B });
  assert.equal(nfp[0].children.length, 0, 'a 3x3 window cannot take a 4x4 part');
});

test('outer NFP of a concave part encloses the part', () => {
  // An L-shape. Whatever the ring looks like in detail, the NFP of a concave
  // A with a non-degenerate B must strictly contain A's bounding box, since
  // B always adds clearance on every side.
  const A = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 4 },
    { x: 4, y: 4 },
    { x: 4, y: 10 },
    { x: 0, y: 10 },
  ];
  const B = rect(0, 0, 2, 2);

  const nfp = DeepnestNFP.calculateNFP({ A, B });
  assert.equal(nfp.length, 1);

  const b = bounds(nfp[0]);
  assert.ok(b.x <= -2 + 1e-6, `left edge ${b.x} should clear A by B's width`);
  assert.ok(b.y <= -2 + 1e-6, `bottom edge ${b.y} should clear A by B's height`);
  assert.ok(b.width >= 12 - 1e-6, `width ${b.width} should span A plus B`);
  assert.ok(b.height >= 12 - 1e-6, `height ${b.height} should span A plus B`);
});

test('degenerate input is rejected rather than throwing', () => {
  // Arrays cross a vm realm boundary here, so compare lengths rather than
  // using deepEqual, which also compares prototypes.
  assert.equal(DeepnestNFP.calculateNFP({ A: [], B: rect(0, 0, 1, 1) }).length, 0);
  assert.equal(DeepnestNFP.calculateNFP({ A: rect(0, 0, 1, 1), B: [] }).length, 0);
  assert.equal(DeepnestNFP.calculateNFP({ A: null, B: null }).length, 0);
  assert.equal(
    DeepnestNFP.calculateNFP({ A: rect(0, 0, 1, 1), B: [{ x: 0, y: 0 }] }).length,
    0,
    'a two-point degenerate B has no area and cannot orbit'
  );
});

// The real contract, and the only test here that would catch a sign error in
// the reference-point shift: walk B's reference point around the computed NFP
// and assert at every vertex that B and A share at most a boundary. This is
// what actually guarantees parts do not collide in a nest.
//
// Run for several shape pairs, including a B drawn far from the origin and a
// concave A, so the shift cancellation is genuinely exercised rather than
// hidden by B[0] happening to be (0,0).
for (const [name, A, B] of [
  ['two rectangles', rect(0, 0, 10, 10), rect(0, 0, 4, 4)],
  ['B drawn far from origin', rect(0, 0, 10, 10), rect(100, -60, 4, 4)],
  ['non-square parts', rect(0, 0, 12, 3), rect(0, 0, 2, 7)],
  [
    'concave A',
    [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 4 },
      { x: 4, y: 4 },
      { x: 4, y: 10 },
      { x: 0, y: 10 },
    ],
    rect(0, 0, 2, 2),
  ],
]) {
  test(`NFP placement is physically valid: ${name}`, () => {
    const nfp = DeepnestNFP.calculateNFP({ A, B })[0];
    assert.ok(nfp && nfp.length >= 3, 'expected a usable NFP ring');

    for (const ref of nfp) {
      // An NFP vertex is a position for B's reference point, so the
      // translation applied to B's own coordinates is (ref - B[0]). This is
      // the same arithmetic placementworker.js does.
      const dx = ref.x - B[0].x;
      const dy = ref.y - B[0].y;
      const placed = B.map((p) => ({ x: p.x + dx, y: p.y + dy }));

      // Overlap is measured as area of intersection, via the same Clipper the
      // nester trusts everywhere else.
      const toClip = (poly) =>
        poly.map(
          (p) =>
            new core.ClipperLib.IntPoint(
              Math.round(p.x * 1e7),
              Math.round(p.y * 1e7)
            )
        );

      const clip = new core.ClipperLib.Clipper();
      clip.AddPath(toClip(A), core.ClipperLib.PolyType.ptSubject, true);
      clip.AddPath(toClip(placed), core.ClipperLib.PolyType.ptClip, true);

      const solution = new core.ClipperLib.Paths();
      clip.Execute(
        core.ClipperLib.ClipType.ctIntersection,
        solution,
        core.ClipperLib.PolyFillType.pftNonZero,
        core.ClipperLib.PolyFillType.pftNonZero
      );

      let overlapArea = 0;
      for (const path of solution) {
        overlapArea += Math.abs(core.ClipperLib.Clipper.Area(path));
      }

      // Coordinates were scaled by 1e7 on each axis, so a real overlap is
      // astronomically large here. Anything this small is float noise along a
      // shared edge, which is exactly what touching parts should produce.
      const overlap = overlapArea / 1e14;
      assert.ok(
        overlap < 1e-6,
        `B placed at (${ref.x}, ${ref.y}) overlaps A by ${overlap}`
      );
    }
  });
}

test('GeometryUtil rectangle detection drives the fast path', () => {
  assert.ok(GeometryUtil.isRectangle(rect(0, 0, 10, 5), 0.001));
  assert.ok(
    !GeometryUtil.isRectangle(
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 5, y: 8 },
      ],
      0.001
    )
  );
});
