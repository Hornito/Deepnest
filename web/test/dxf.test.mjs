/*
 * DXF import tests.
 *
 * DXF is the format that matters most here: it is what every CAD package
 * exports for cutting, and it is the format DWG is converted into. These tests
 * check real geometry - dimensions, curve expansion, unit handling - rather
 * than just "it did not throw".
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { parseDxf, dxfToSvg } from '../src/import/dxf.js';

/* Build DXF group-code text from [code, value] pairs. */
const dxf = (pairs) => pairs.map(([c, v]) => `${c}\n${v}`).join('\n') + '\n';

const withEntities = (entityPairs, headerPairs = []) =>
  dxf([
    [0, 'SECTION'],
    [2, 'HEADER'],
    ...headerPairs,
    [0, 'ENDSEC'],
    [0, 'SECTION'],
    [2, 'ENTITIES'],
    ...entityPairs,
    [0, 'ENDSEC'],
    [0, 'EOF'],
  ]);

const MM_HEADER = [
  [9, '$INSUNITS'],
  [70, '4'],
];

const RECT_100x50 = [
  [0, 'LWPOLYLINE'],
  [8, '0'],
  [90, '4'],
  [70, '1'],
  [10, '0.0'],
  [20, '0.0'],
  [10, '100.0'],
  [20, '0.0'],
  [10, '100.0'],
  [20, '50.0'],
  [10, '0.0'],
  [20, '50.0'],
];

function bounds(points) {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  };
}

const close = (a, b, tol = 1e-3) =>
  assert.ok(Math.abs(a - b) < tol, `expected ${a} to be within ${tol} of ${b}`);

test('parses a closed LWPOLYLINE rectangle at its true size', () => {
  const { polylines } = parseDxf(withEntities(RECT_100x50, MM_HEADER));

  assert.equal(polylines.length, 1);
  assert.equal(polylines[0].closed, true, 'flag 70=1 marks the polyline closed');

  const b = bounds(polylines[0]);
  close(b.maxX - b.minX, 100);
  close(b.maxY - b.minY, 50);
});

test('expands a CIRCLE into a polygon of the correct radius', () => {
  const { polylines } = parseDxf(
    withEntities(
      [
        [0, 'CIRCLE'],
        [8, '0'],
        [10, '50.0'],
        [20, '25.0'],
        [40, '10.0'],
      ],
      MM_HEADER
    )
  );

  assert.equal(polylines.length, 1);
  const points = polylines[0];

  // Enough segments to stay inside tolerance, but not absurdly many.
  assert.ok(points.length >= 8, `expected a tessellated circle, got ${points.length} points`);
  assert.ok(points.length < 400, `circle over-tessellated: ${points.length} points`);

  const b = bounds(points);
  close(b.maxX - b.minX, 20, 0.05);
  close(b.maxY - b.minY, 20, 0.05);

  // Every sample must sit on the circle.
  for (const p of points) {
    close(Math.hypot(p.x - 50, p.y - 25), 10, 0.05);
  }
});

test('curve tessellation stays within the stated tolerance', () => {
  // A large circle is the stress case: too few segments and the chord error
  // grows past the 0.05mm budget, which would cut inside the true profile.
  const { polylines } = parseDxf(
    withEntities(
      [
        [0, 'CIRCLE'],
        [8, '0'],
        [10, '0.0'],
        [20, '0.0'],
        [40, '500.0'],
      ],
      MM_HEADER
    )
  );

  const points = polylines[0];
  let worst = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    // Distance from the chord midpoint to the true arc.
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    worst = Math.max(worst, 500 - Math.hypot(mid.x, mid.y));
  }

  assert.ok(worst <= 0.05 + 1e-6, `chord error ${worst}mm exceeds the 0.05mm budget`);
});

test('expands polyline bulges into arcs rather than chamfering them', () => {
  // Two vertices with a bulge of 1 = a half circle. Ignoring the bulge would
  // give a straight line, and a part smaller than the drawing.
  const { polylines } = parseDxf(
    withEntities(
      [
        [0, 'LWPOLYLINE'],
        [8, '0'],
        [90, '2'],
        [70, '0'],
        [10, '0.0'],
        [20, '0.0'],
        [42, '1.0'],
        [10, '10.0'],
        [20, '0.0'],
      ],
      MM_HEADER
    )
  );

  const points = polylines[0];
  assert.ok(points.length > 2, 'bulge must expand into intermediate points');

  const b = bounds(points);
  // A semicircle on a 10-unit chord bulges 5 units out.
  close(b.maxY - b.minY, 5, 0.05);
  close(b.maxX - b.minX, 10, 0.05);
});

test('resolves INSERT block references with translation and rotation', () => {
  const source = dxf([
    [0, 'SECTION'],
    [2, 'HEADER'],
    ...MM_HEADER,
    [0, 'ENDSEC'],
    [0, 'SECTION'],
    [2, 'BLOCKS'],
    [0, 'BLOCK'],
    [2, 'SQUARE'],
    [10, '0.0'],
    [20, '0.0'],
    [0, 'LWPOLYLINE'],
    [90, '4'],
    [70, '1'],
    [10, '0.0'],
    [20, '0.0'],
    [10, '10.0'],
    [20, '0.0'],
    [10, '10.0'],
    [20, '10.0'],
    [10, '0.0'],
    [20, '10.0'],
    [0, 'ENDBLK'],
    [0, 'ENDSEC'],
    [0, 'SECTION'],
    [2, 'ENTITIES'],
    [0, 'INSERT'],
    [2, 'SQUARE'],
    [10, '100.0'],
    [20, '200.0'],
    [0, 'ENDSEC'],
    [0, 'EOF'],
  ]);

  const { polylines } = parseDxf(source);

  assert.equal(polylines.length, 1, 'the block contents should be emitted');
  const b = bounds(polylines[0]);
  close(b.minX, 100);
  close(b.minY, 200);
  close(b.maxX - b.minX, 10);
});

test('ignores annotation entities', () => {
  const { polylines } = parseDxf(
    withEntities(
      [
        ...RECT_100x50,
        [0, 'TEXT'],
        [8, '0'],
        [10, '10.0'],
        [20, '10.0'],
        [40, '5.0'],
        [1, 'PART A'],
      ],
      MM_HEADER
    )
  );

  assert.equal(polylines.length, 1, 'TEXT must not become cut geometry');
});

test('reads $INSUNITS so millimetre and inch drawings scale correctly', () => {
  const mm = parseDxf(withEntities(RECT_100x50, MM_HEADER));
  assert.equal(mm.unitScale, 1);

  const inches = parseDxf(
    withEntities(RECT_100x50, [
      [9, '$INSUNITS'],
      [70, '1'],
    ])
  );
  assert.equal(inches.unitScale, 25.4, 'inch drawings are 25.4mm per unit');
});

test('flags a drawing that declares no units', () => {
  const result = dxfToSvg(withEntities(RECT_100x50));
  assert.equal(result.unitsKnown, false, 'caller must be able to warn the user');
});

test('converts to SVG with Y flipped and the origin normalised', () => {
  // Geometry placed at negative coordinates, which DXF allows and SVG
  // viewBoxes handle badly.
  const shifted = withEntities(
    [
      [0, 'LWPOLYLINE'],
      [8, '0'],
      [90, '4'],
      [70, '1'],
      [10, '-100.0'],
      [20, '-100.0'],
      [10, '-50.0'],
      [20, '-100.0'],
      [10, '-50.0'],
      [20, '-80.0'],
      [10, '-100.0'],
      [20, '-80.0'],
    ],
    MM_HEADER
  );

  const { svg } = dxfToSvg(shifted);

  assert.match(svg, /^<svg /);
  // Millimetres are declared on width/height so SvgParser can derive the
  // drawing's real-world scale; the viewBox carries the same numbers.
  assert.match(svg, /width="50mm"/);
  assert.match(svg, /height="20mm"/);
  assert.match(svg, /viewBox="0 0 50 20"/);
  // Normalised to the origin, so no negative coordinates survive in the path.
  const d = svg.match(/ d="([^"]+)"/)[1];
  assert.ok(!d.includes('-'), `path should be origin-normalised, got: ${d}`);
});

test('rejects a DXF with no cuttable geometry, with an actionable message', () => {
  const textOnly = withEntities(
    [
      [0, 'TEXT'],
      [8, '0'],
      [10, '0.0'],
      [20, '0.0'],
      [40, '5.0'],
      [1, 'NOTES'],
    ],
    MM_HEADER
  );

  assert.throws(() => dxfToSvg(textOnly), /No cuttable geometry/);
});

test('rejects malformed input rather than producing empty parts', () => {
  assert.throws(() => dxfToSvg('this is not a dxf file'), /Could not parse DXF|No cuttable geometry/);
});
