/*
 * Turning imported SVG into nestable parts.
 *
 * SvgParser gives us drawing elements; the nester needs closed polygons
 * arranged into a tree, where a root is a part and its children are holes.
 * This module bridges the two, following the same approach as the desktop
 * app's DeepNest.getParts.
 */

import { ClipperLib, GeometryUtil, SvgParser } from './globals.js';

const CLIPPER_SCALE = 10000000;

function svgToClipper(polygon, scale = CLIPPER_SCALE) {
  const clip = polygon.map((p) => ({ X: p.x, Y: p.y }));
  ClipperLib.JS.ScaleUpPath(clip, scale);
  return clip;
}

function clipperToSvg(polygon, scale = CLIPPER_SCALE) {
  return polygon.map((p) => ({ x: p.X / scale, y: p.Y / scale }));
}

/*
 * Remove self-intersections, coincident points and hairline edges.
 *
 * Imported CAD geometry is full of these: a polyline that doubles back on
 * itself, or two vertices a nanometre apart. They make the NFP algorithms
 * produce garbage, so clean before nesting rather than debugging later.
 */
export function cleanPolygon(polygon, curveTolerance) {
  const clipperPolygon = svgToClipper(polygon);

  const simple = ClipperLib.Clipper.SimplifyPolygon(
    clipperPolygon,
    ClipperLib.PolyFillType.pftNonZero
  );

  if (!simple || simple.length === 0) {
    return null;
  }

  // Self-intersection can split one ring into several. Keep the largest:
  // the others are the slivers the crossing created.
  let biggest = simple[0];
  let biggestArea = Math.abs(ClipperLib.Clipper.Area(biggest));
  for (let i = 1; i < simple.length; i++) {
    const area = Math.abs(ClipperLib.Clipper.Area(simple[i]));
    if (area > biggestArea) {
      biggest = simple[i];
      biggestArea = area;
    }
  }

  const clean = ClipperLib.Clipper.CleanPolygon(
    biggest,
    0.01 * curveTolerance * CLIPPER_SCALE
  );

  if (!clean || clean.length === 0) {
    return null;
  }

  const cleaned = clipperToSvg(clean);

  // A closed ring that repeats its first point as its last confuses the
  // orbiting NFP, which treats it as a zero-length edge.
  const start = cleaned[0];
  const end = cleaned[cleaned.length - 1];
  if (
    start === end ||
    (GeometryUtil.almostEqual(start.x, end.x) &&
      GeometryUtil.almostEqual(start.y, end.y))
  ) {
    cleaned.pop();
  }

  return cleaned;
}

function pointInClipperPolygon(point, polygon) {
  const pt = new ClipperLib.IntPoint(
    CLIPPER_SCALE * point.x,
    CLIPPER_SCALE * point.y
  );
  return ClipperLib.Clipper.PointInPolygon(pt, polygon) > 0;
}

/*
 * Arrange a flat list of rings into parts and holes.
 *
 * A ring wholly inside another is a hole of it; a ring inside a hole is a
 * part again (an island), and so on. Nesting depth alternates, which is why
 * this recurses rather than treating "inside anything" as "is a hole".
 *
 * Containment is decided by sampling points rather than testing every vertex:
 * two rings that share an edge would otherwise give an ambiguous answer.
 */
function toTree(list, idStart = 0) {
  const parents = [];

  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    let isChild = false;

    for (let j = 0; j < list.length; j++) {
      if (j === i || p.length < 2) {
        continue;
      }

      const container = svgToClipper(list[j]);
      const samples = Math.min(10, p.length);
      let inside = 0;
      for (let k = 0; k < samples; k++) {
        if (pointInClipperPolygon(p[k], container)) {
          inside++;
        }
      }

      // A clear majority, not all: a shared edge can put a vertex marginally
      // outside its true container.
      if (inside > 0.5 * samples) {
        if (!list[j].children) {
          list[j].children = [];
        }
        list[j].children.push(p);
        p.parent = list[j];
        isChild = true;
        break;
      }
    }

    if (!isChild) {
      parents.push(p);
    }
  }

  // Anything not a root has already been attached to its parent above.
  let id = idStart;
  for (const parent of parents) {
    parent.id = id++;
  }

  for (const parent of parents) {
    if (parent.children) {
      id = toTree(parent.children, id);
    }
  }

  return id;
}

/*
 * Parse an SVG string into parts.
 *
 * `scale` is the app's internal units per inch, matching SvgParser's
 * expectation; `scalingFactor` lets a converted format (DXF/STEP) declare its
 * own unit scale.
 */
export function partsFromSvg(svgString, options = {}) {
  const {
    scale = 72,
    scalingFactor = null,
    curveTolerance = 0.3,
    dxfFlag = false,
  } = options;

  SvgParser.config({ tolerance: curveTolerance });

  let svg = SvgParser.load(null, svgString, scale, scalingFactor);
  svg = SvgParser.clean(dxfFlag);

  const elements = Array.from(svg.children);
  const polygons = [];

  for (let i = 0; i < elements.length; i++) {
    const element = elements[i];

    if (SvgParser.polygonElements.indexOf(element.tagName) < 0) {
      continue;
    }

    // Open paths are cut lines, not outlines - they enclose no area and
    // cannot be nested.
    if (!SvgParser.isClosed(element, 2 * curveTolerance)) {
      continue;
    }

    let poly = SvgParser.polygonify(element);
    poly = cleanPolygon(poly, curveTolerance);

    if (
      poly &&
      poly.length > 2 &&
      Math.abs(GeometryUtil.polygonArea(poly)) >
        curveTolerance * curveTolerance
    ) {
      poly.source = i;
      polygons.push(poly);
    }
  }

  toTree(polygons);

  return { svg, parts: polygons.filter((p) => !p.parent) };
}

/*
 * Offset a part outward by half the spacing, so that two parts placed edge to
 * edge end up a full spacing apart.
 *
 * Returns the original polygon when spacing is zero, and null if the offset
 * collapses the part - which happens when an inward offset exceeds the part's
 * own width.
 */
export function offsetPart(polygon, spacing, curveTolerance) {
  if (!spacing || spacing === 0) {
    return polygon;
  }

  const offset = spacing / 2;
  const miterLimit = 2;

  const p = svgToClipper(polygon);
  const co = new ClipperLib.ClipperOffset(
    miterLimit,
    curveTolerance * CLIPPER_SCALE
  );
  co.AddPath(
    p,
    ClipperLib.JoinType.jtRound,
    ClipperLib.EndType.etClosedPolygon
  );

  const result = new ClipperLib.Paths();
  co.Execute(result, offset * CLIPPER_SCALE);

  if (!result || result.length === 0) {
    return null;
  }

  // Keep the largest ring; rounding a concave corner can shed slivers.
  let biggest = result[0];
  let biggestArea = Math.abs(ClipperLib.Clipper.Area(biggest));
  for (let i = 1; i < result.length; i++) {
    const area = Math.abs(ClipperLib.Clipper.Area(result[i]));
    if (area > biggestArea) {
      biggest = result[i];
      biggestArea = area;
    }
  }

  const offsetPolygon = clipperToSvg(biggest);
  offsetPolygon.id = polygon.id;
  offsetPolygon.source = polygon.source;

  // Holes shrink as the outline grows, so offset them the other way.
  if (polygon.children && polygon.children.length > 0) {
    offsetPolygon.children = [];
    for (const child of polygon.children) {
      const shrunk = offsetPart(child, -spacing, curveTolerance);
      if (shrunk && shrunk.length > 2) {
        offsetPolygon.children.push(shrunk);
      }
    }
  }

  return offsetPolygon;
}

/* Bounding box of a part including nothing but its outline. */
export function partBounds(polygon) {
  return GeometryUtil.getPolygonBounds(polygon);
}
