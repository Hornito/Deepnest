/*
 * DXF import.
 *
 * The desktop app does not parse DXF at all - it uploads the file to
 * convert.deepnest.io and gets SVG back. That is a hard dependency on a
 * third-party server for a core feature, and it means DXF import breaks when
 * the server is down and leaks part geometry to it either way. Here we parse
 * DXF locally and never send anything anywhere.
 *
 * Output is an SVG string, because the rest of Deepnest (SvgParser, the part
 * tree, the exporters) already speaks SVG. Converting DXF -> SVG lets all of
 * that work unchanged.
 */

import DxfParser from 'dxf-parser';

// DXF stores no physical unit on geometry; $INSUNITS in the header says what
// one drawing unit means. Values are from the DXF spec.
const INSUNITS = {
  0: null, // unitless - caller decides
  1: 25.4, // inches
  2: 304.8, // feet
  4: 1, // millimetres
  5: 10, // centimetres
  6: 1000, // metres
  8: 0.0254, // microinches
  9: 0.0254, // mils
  10: 914.4, // yards
  11: 1e-7, // angstroms
  12: 1e-6, // nanometres
  13: 0.001, // microns
  14: 100, // decimetres
  15: 10000, // decametres
  16: 100000, // hectometres
  17: 1e9, // gigametres
};

/*
 * How finely curves are approximated, in millimetres of maximum deviation
 * from the true curve. Deepnest nests polygons, so every arc, circle and
 * spline has to become line segments at some point.
 *
 * 0.05mm is well under the kerf of any real laser or router, so the
 * approximation cannot cause a bad cut, while keeping point counts low enough
 * that the NFP computation stays fast.
 */
const CURVE_TOLERANCE_MM = 0.05;

const TAU = Math.PI * 2;

/*
 * Number of straight segments to approximate an arc of `radius` sweeping
 * `sweep` radians, such that the sagitta stays under the tolerance.
 *
 * For a chord subtending angle t on radius r, the deviation is
 * r * (1 - cos(t/2)). Solving for t gives the step below.
 */
function arcSegments(radius, sweep, tolerance) {
  if (!(radius > 0)) {
    return 1;
  }
  const ratio = Math.max(-1, Math.min(1, 1 - tolerance / radius));
  const step = 2 * Math.acos(ratio);
  if (!(step > 1e-9)) {
    return 128;
  }
  return Math.max(2, Math.min(2048, Math.ceil(Math.abs(sweep) / step)));
}

function arcPoints(cx, cy, radius, startAngle, endAngle, tolerance) {
  let sweep = endAngle - startAngle;
  // Normalise to a positive sweep so segment counts are never negative.
  while (sweep <= 0) sweep += TAU;
  while (sweep > TAU) sweep -= TAU;

  const steps = arcSegments(radius, sweep, tolerance);
  const points = [];
  for (let i = 0; i <= steps; i++) {
    const a = startAngle + (sweep * i) / steps;
    points.push({ x: cx + radius * Math.cos(a), y: cy + radius * Math.sin(a) });
  }
  return points;
}

function ellipsePoints(entity, tolerance) {
  // DXF ELLIPSE: centre, an endpoint of the major axis (relative to centre),
  // and the minor/major ratio. Angles are parameters, not true angles.
  const cx = entity.center?.x ?? 0;
  const cy = entity.center?.y ?? 0;
  const mx = entity.majorAxisEndPoint?.x ?? 0;
  const my = entity.majorAxisEndPoint?.y ?? 0;

  const major = Math.hypot(mx, my);
  const ratio = entity.axisRatio ?? 1;
  const minor = major * ratio;
  const rotation = Math.atan2(my, mx);

  let start = entity.startAngle ?? 0;
  let end = entity.endAngle ?? TAU;
  let sweep = end - start;
  while (sweep <= 0) sweep += TAU;
  while (sweep > TAU) sweep -= TAU;

  // Use the major radius for the segment count: it bounds the error.
  const steps = arcSegments(major, sweep, tolerance);
  const points = [];
  for (let i = 0; i <= steps; i++) {
    const t = start + (sweep * i) / steps;
    const x = major * Math.cos(t);
    const y = minor * Math.sin(t);
    points.push({
      x: cx + x * Math.cos(rotation) - y * Math.sin(rotation),
      y: cy + x * Math.sin(rotation) + y * Math.cos(rotation),
    });
  }
  return points;
}

/*
 * LWPOLYLINE / POLYLINE vertices may carry a `bulge`, which encodes a
 * circular arc to the next vertex. Bulge is tan(theta/4) where theta is the
 * included angle - ignoring it turns filleted corners into chamfers and
 * quietly shrinks parts, so it has to be expanded.
 */
function bulgeArc(from, to, bulge, tolerance) {
  if (!bulge) {
    return [];
  }

  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const chord = Math.hypot(dx, dy);
  if (chord < 1e-12) {
    return [];
  }

  const theta = 4 * Math.atan(bulge);
  const radius = chord / (2 * Math.sin(Math.abs(theta) / 2));

  // Centre lies off the chord midpoint, on the side the bulge sign picks.
  const mx = (from.x + to.x) / 2;
  const my = (from.y + to.y) / 2;
  const h = radius * Math.cos(theta / 2);
  const sign = bulge > 0 ? 1 : -1;
  const cx = mx - (sign * h * dy) / chord;
  const cy = my + (sign * h * dx) / chord;

  const startAngle = Math.atan2(from.y - cy, from.x - cx);
  const sweep = theta;
  const steps = arcSegments(radius, sweep, tolerance);

  const points = [];
  // Skip i=0 and i=steps: the caller already has both endpoints.
  for (let i = 1; i < steps; i++) {
    const a = startAngle + (sweep * i) / steps;
    points.push({ x: cx + radius * Math.cos(a), y: cy + radius * Math.sin(a) });
  }
  return points;
}

/*
 * SPLINE. dxf-parser hands back control points and knots. Rather than
 * implement a full NURBS evaluator, use the control polygon when the spline is
 * degree 1, and de Boor for the common degree 2/3 cases.
 */
function splinePoints(entity, tolerance) {
  const controls = entity.controlPoints || [];
  if (controls.length === 0) {
    return (entity.fitPoints || []).map((p) => ({ x: p.x, y: p.y }));
  }

  const degree = entity.degreeOfSplineCurve ?? 3;
  if (degree <= 1 || controls.length <= degree) {
    return controls.map((p) => ({ x: p.x, y: p.y }));
  }

  const knots = entity.knotValues || [];
  if (knots.length < controls.length + degree + 1) {
    // Malformed knot vector: fall back to the control polygon rather than
    // producing garbage geometry.
    return controls.map((p) => ({ x: p.x, y: p.y }));
  }

  // Sample density scaled to the control polygon's size, so big splines get
  // more points than small ones at the same tolerance.
  let extent = 0;
  for (let i = 1; i < controls.length; i++) {
    extent += Math.hypot(
      controls[i].x - controls[i - 1].x,
      controls[i].y - controls[i - 1].y
    );
  }
  const steps = Math.max(
    16,
    Math.min(2048, Math.ceil(extent / Math.max(tolerance, 1e-6)))
  );

  const domainStart = knots[degree];
  const domainEnd = knots[controls.length];

  const points = [];
  for (let i = 0; i <= steps; i++) {
    const t = domainStart + ((domainEnd - domainStart) * i) / steps;
    const p = deBoor(t, degree, controls, knots);
    if (p) {
      points.push(p);
    }
  }
  return points;
}

function deBoor(t, degree, controls, knots) {
  const n = controls.length;

  // Find the knot span containing t.
  let k = degree;
  while (k < n && knots[k + 1] < t) {
    k++;
  }
  k = Math.min(Math.max(k, degree), n - 1);

  const d = [];
  for (let j = 0; j <= degree; j++) {
    const idx = Math.min(Math.max(k - degree + j, 0), n - 1);
    d.push({ x: controls[idx].x, y: controls[idx].y });
  }

  for (let r = 1; r <= degree; r++) {
    for (let j = degree; j >= r; j--) {
      const i = k - degree + j;
      const denom = knots[i + degree - r + 1] - knots[i];
      const alpha = denom === 0 ? 0 : (t - knots[i]) / denom;
      d[j] = {
        x: (1 - alpha) * d[j - 1].x + alpha * d[j].x,
        y: (1 - alpha) * d[j - 1].y + alpha * d[j].y,
      };
    }
  }

  return d[degree];
}

/* Apply a 2D transform (from a block INSERT) to a point. */
function transformPoint(p, t) {
  if (!t) {
    return p;
  }
  const sx = p.x * t.scaleX;
  const sy = p.y * t.scaleY;
  return {
    x: t.x + sx * Math.cos(t.rotation) - sy * Math.sin(t.rotation),
    y: t.y + sx * Math.sin(t.rotation) + sy * Math.cos(t.rotation),
  };
}

/*
 * Convert one entity to zero or more polylines (arrays of points).
 *
 * Text, dimensions and hatches are deliberately dropped: they are annotation,
 * not cut geometry, and nesting them would produce nonsense parts.
 */
function entityToPolylines(entity, blocks, transform, tolerance, depth = 0) {
  const out = [];
  const push = (points, closed) => {
    if (points && points.length > 1) {
      const mapped = transform
        ? points.map((p) => transformPoint(p, transform))
        : points;
      mapped.closed = !!closed;
      out.push(mapped);
    }
  };

  switch (entity.type) {
    case 'LINE': {
      const v = entity.vertices || [];
      if (v.length >= 2) {
        push([
          { x: v[0].x, y: v[0].y },
          { x: v[1].x, y: v[1].y },
        ]);
      }
      break;
    }

    case 'LWPOLYLINE':
    case 'POLYLINE': {
      const vertices = entity.vertices || [];
      if (vertices.length < 2) {
        break;
      }
      const points = [];
      for (let i = 0; i < vertices.length; i++) {
        const v = vertices[i];
        points.push({ x: v.x, y: v.y });

        const next = vertices[i + 1] ?? (entity.shape ? vertices[0] : null);
        if (next && v.bulge) {
          points.push(...bulgeArc(v, next, v.bulge, tolerance));
        }
      }
      push(points, entity.shape || entity.closed);
      break;
    }

    case 'CIRCLE': {
      const points = arcPoints(
        entity.center.x,
        entity.center.y,
        entity.radius,
        0,
        TAU,
        tolerance
      );
      // A full circle's first and last sample coincide; drop the duplicate.
      points.pop();
      push(points, true);
      break;
    }

    case 'ARC': {
      // dxf-parser reports these in radians already.
      push(
        arcPoints(
          entity.center.x,
          entity.center.y,
          entity.radius,
          entity.startAngle,
          entity.endAngle,
          tolerance
        )
      );
      break;
    }

    case 'ELLIPSE': {
      const points = ellipsePoints(entity, tolerance);
      const full = Math.abs((entity.endAngle ?? TAU) - (entity.startAngle ?? 0) - TAU) < 1e-9;
      if (full) {
        points.pop();
      }
      push(points, full);
      break;
    }

    case 'SPLINE': {
      push(splinePoints(entity, tolerance), entity.closed);
      break;
    }

    case 'INSERT': {
      // Block reference. Recurse into the block definition, composing
      // transforms. Depth-limited so a self-referential block cannot hang the
      // tab - malformed DXFs in the wild do contain these.
      if (depth > 16) {
        break;
      }
      const block = blocks?.[entity.name];
      if (!block?.entities) {
        break;
      }

      const child = {
        x: entity.position?.x ?? 0,
        y: entity.position?.y ?? 0,
        scaleX: entity.xScale ?? 1,
        scaleY: entity.yScale ?? 1,
        rotation: ((entity.rotation ?? 0) * Math.PI) / 180,
      };

      // Blocks position their contents relative to the block's base point.
      const basePoint = block.position || { x: 0, y: 0 };

      for (const sub of block.entities) {
        const nested = entityToPolylines(
          sub,
          blocks,
          null,
          tolerance,
          depth + 1
        );
        for (const poly of nested) {
          const moved = poly.map((p) =>
            transformPoint({ x: p.x - basePoint.x, y: p.y - basePoint.y }, child)
          );
          const finalPoints = transform
            ? moved.map((p) => transformPoint(p, transform))
            : moved;
          finalPoints.closed = poly.closed;
          out.push(finalPoints);
        }
      }
      break;
    }

    default:
      // TEXT, MTEXT, DIMENSION, HATCH, POINT, LEADER and friends: annotation.
      break;
  }

  return out;
}

/*
 * Parse DXF text into polylines plus the drawing's unit scale.
 * Exported separately from the SVG conversion so tests can assert on geometry
 * without going through a DOM.
 */
export function parseDxf(text) {
  const parser = new DxfParser();
  let dxf;
  try {
    dxf = parser.parseSync(text);
  } catch (err) {
    throw new Error(`Could not parse DXF: ${err.message}`);
  }

  if (!dxf) {
    throw new Error('Could not parse DXF: file produced no drawing data.');
  }

  const insunits = dxf.header?.$INSUNITS;
  const unitScale = INSUNITS[insunits] ?? null;

  // Work the curve tolerance back into drawing units so a file in inches is
  // not tessellated 25x more finely than one in millimetres.
  const tolerance =
    unitScale && unitScale > 0
      ? CURVE_TOLERANCE_MM / unitScale
      : CURVE_TOLERANCE_MM;

  const polylines = [];
  for (const entity of dxf.entities || []) {
    polylines.push(
      ...entityToPolylines(entity, dxf.blocks, null, tolerance)
    );
  }

  return { polylines, unitScale, insunits };
}

/*
 * DXF -> SVG.
 *
 * Three coordinate concerns are handled here:
 *
 *  - DXF has Y up, SVG has Y down, so Y is flipped about the bounding box.
 *  - DXF has no origin convention, so geometry can sit anywhere, including at
 *    large negative coordinates. Translating to the bounding box origin keeps
 *    the SVG viewBox sane.
 *  - The output is emitted in MILLIMETRES, with a unit-suffixed width/height
 *    and a matching viewBox. That is deliberate: SvgParser derives an SVG's
 *    real-world scale from exactly that pairing, so declaring the unit here
 *    lets it do the conversion to internal units. Scaling the coordinates
 *    ourselves as well would apply the factor twice.
 */
export function dxfToSvg(text) {
  const { polylines, unitScale, insunits } = parseDxf(text);

  if (polylines.length === 0) {
    throw new Error(
      'No cuttable geometry found in this DXF. ' +
        'Only lines, polylines, arcs, circles, ellipses and splines are nested - ' +
        'text, dimensions and hatches are ignored.'
    );
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const poly of polylines) {
    for (const p of poly) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
  }

  // Drawing units -> millimetres. A DXF that declares no units is assumed to
  // be millimetres; the caller is told so it can warn.
  const scale = unitScale ?? 1;

  const width = (maxX - minX) * scale;
  const height = (maxY - minY) * scale;

  const fmt = (n) => (Math.round(n * 1e6) / 1e6).toString();

  const paths = polylines
    .map((poly) => {
      const d =
        poly
          .map((p, i) => {
            const x = (p.x - minX) * scale;
            // Flip Y into SVG's coordinate space.
            const y = (maxY - p.y) * scale;
            return `${i === 0 ? 'M' : 'L'}${fmt(x)},${fmt(y)}`;
          })
          .join(' ') + (poly.closed ? ' Z' : '');
      return `<path d="${d}" fill="none" stroke="#000" stroke-width="0.1"/>`;
    })
    .join('\n  ');

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" ` +
    `width="${fmt(width)}mm" height="${fmt(height)}mm" ` +
    `viewBox="0 0 ${fmt(width)} ${fmt(height)}">\n  ${paths}\n</svg>`;

  return {
    svg,
    unitScale,
    insunits,
    // Surfaced so the UI can warn when a DXF declares no units and the
    // physical size of the part is therefore a guess.
    unitsKnown: unitScale !== null,
    polylineCount: polylines.length,
  };
}
