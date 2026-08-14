/*
 * Pure-JavaScript replacement for Deepnest's native `calculateNFP` addon.
 *
 * The desktop app computes no-fit polygons in C++ (minkowski.cc), using a
 * Boost.Polygon convolution over a polygon set. That is a compiled Node addon
 * and cannot be loaded in a browser, so this file reproduces its output using
 * only ClipperLib and GeometryUtil - both of which already ship with Deepnest.
 *
 * What the addon returns, for a stationary part A and an orbiting part B:
 *
 *   - the OUTER no-fit polygon: the locus of B's reference point such that B
 *     touches A but does not overlap it. B can be placed anywhere outside it.
 *   - `children`: the INTERIOR no-fit polygons - one per hole of A that is big
 *     enough to swallow B. B may be placed inside any of these.
 *
 * The key observation that lets us skip Boost entirely is that those two
 * pieces are independent:
 *
 *   - the outer NFP is a function of A's OUTER BOUNDARY only. A's holes cannot
 *     influence where B sits when B is outside A.
 *   - each interior NFP is a function of ONE hole and B, and nothing else.
 *
 * So the outer NFP comes from a Clipper Minkowski sum (A (+) -B), and each
 * interior NFP comes from GeometryUtil's orbiting inner-NFP routine. This is
 * the same decomposition upstream SVGnest uses in svgnest.js, where holes are
 * handled with `GeometryUtil.noFitPolygon(A.children[i], B, true, searchEdges)`.
 *
 * Loaded via importScripts() in the nesting worker; also loadable in Node for
 * the unit tests in test/nfp.test.mjs. Requires ClipperLib and GeometryUtil to
 * already be on the global object.
 */
(function (root) {
  'use strict';

  // Clipper works on integers. Deepnest's own clipper path in background.js
  // uses this same factor, so NFPs stay bit-comparable with the desktop app.
  var CLIPPER_SCALE = 10000000;

  // jsClipper uses X/Y, the nesting code uses x/y.
  function toClipperCoordinates(polygon) {
    var clone = [];
    for (var i = 0; i < polygon.length; i++) {
      clone.push({ X: polygon[i].x, Y: polygon[i].y });
    }
    return clone;
  }

  function toNestCoordinates(polygon, scale) {
    var clone = [];
    for (var i = 0; i < polygon.length; i++) {
      clone.push({ x: polygon[i].X / scale, y: polygon[i].Y / scale });
    }
    return clone;
  }

  /*
   * Outer NFP via Minkowski sum: A (+) (-B), shifted so the result is
   * expressed relative to B's first point.
   *
   * The shift matters and is easy to get wrong. The nesting code treats an NFP
   * as positions for B's REFERENCE POINT (B[0]), but a raw Minkowski sum is
   * expressed relative to the origin. minkowski.cc compensates by adding B[0]
   * back to every output point; we do the same.
   */
  function outerNfpMinkowski(A, B) {
    var Ac = toClipperCoordinates(A);
    ClipperLib.JS.ScaleUpPath(Ac, CLIPPER_SCALE);

    var Bc = toClipperCoordinates(B);
    ClipperLib.JS.ScaleUpPath(Bc, CLIPPER_SCALE);
    for (var i = 0; i < Bc.length; i++) {
      Bc[i].X *= -1;
      Bc[i].Y *= -1;
    }

    var solution = ClipperLib.Clipper.MinkowskiSum(Ac, Bc, true);
    if (!solution || solution.length === 0) {
      return null;
    }

    // The sum can come back as several rings when A is concave enough that the
    // convolution self-intersects. The NFP proper is the one enclosing the
    // rest, which is always the one with the largest area.
    var best = null;
    var largestArea = null;
    for (i = 0; i < solution.length; i++) {
      var n = toNestCoordinates(solution[i], CLIPPER_SCALE);
      var sarea = -GeometryUtil.polygonArea(n);
      if (largestArea === null || largestArea < sarea) {
        best = n;
        largestArea = sarea;
      }
    }

    if (!best || best.length === 0) {
      return null;
    }

    for (i = 0; i < best.length; i++) {
      best[i].x += B[0].x;
      best[i].y += B[0].y;
    }

    return best;
  }

  /*
   * Interior NFP: where B's reference point can sit for B to lie entirely
   * inside the closed region `container`.
   *
   * A rectangular container - which is every sheet produced from the material
   * library - has a closed-form answer, so take that path when it applies. It
   * is both faster and numerically exact, where the orbiting algorithm can
   * drift on long straight edges.
   */
  function innerNfp(container, B, searchEdges) {
    if (!container || container.length < 3) {
      return null;
    }

    if (GeometryUtil.isRectangle(container, 0.001)) {
      return GeometryUtil.noFitPolygonRectangle(container, B);
    }

    return GeometryUtil.noFitPolygon(container, B, true, searchEdges);
  }

  /*
   * Drop-in for the native addon: calculateNFP({A, B}).
   *
   * `A.children` are A's holes, `inside` requests the interior NFP of A itself
   * (used when A is the sheet). Returns an array of rings; the first carries a
   * `children` array holding the interior NFPs of A's holes, matching the
   * shape background.js expects from the addon.
   */
  function calculateNFP(group) {
    var A = group.A;
    var B = group.B;
    var inside = !!group.inside;
    var searchEdges = !!group.searchEdges;

    if (!A || !B || A.length < 3 || B.length < 3) {
      return [];
    }

    // Placing B inside A (A is a sheet or an enclosing region).
    if (inside) {
      var nfp = innerNfp(A, B, searchEdges);
      if (!nfp || nfp.length === 0) {
        return [];
      }
      return nfp;
    }

    var outer = outerNfpMinkowski(A, B);
    if (!outer) {
      return [];
    }

    // Each hole of A that can accept B contributes an interior NFP. These ride
    // along as `children` of the outer ring, which is how the placement worker
    // discovers that a part may be nested inside another part's hole.
    var children = [];
    if (A.children && A.children.length > 0) {
      for (var i = 0; i < A.children.length; i++) {
        var hole = A.children[i];
        if (!hole || hole.length < 3) {
          continue;
        }

        // Cheap rejection: a hole smaller than B can never take it, and the
        // orbiting search is expensive enough to be worth avoiding.
        var holeBounds = GeometryUtil.getPolygonBounds(hole);
        var bBounds = GeometryUtil.getPolygonBounds(B);
        if (
          !holeBounds ||
          !bBounds ||
          holeBounds.width < bBounds.width ||
          holeBounds.height < bBounds.height
        ) {
          continue;
        }

        var cnfp = innerNfp(hole, B, searchEdges);
        if (cnfp && cnfp.length > 0) {
          for (var j = 0; j < cnfp.length; j++) {
            if (cnfp[j] && cnfp[j].length > 2) {
              children.push(cnfp[j]);
            }
          }
        }
      }
    }

    outer.children = children;
    return [outer];
  }

  root.DeepnestNFP = {
    calculateNFP: calculateNFP,
    outerNfpMinkowski: outerNfpMinkowski,
    innerNfp: innerNfp,
    CLIPPER_SCALE: CLIPPER_SCALE,
  };

  // The worker calls this by the same name the addon used, so the ported
  // background code needs no conditional.
  root.addon = root.addon || { calculateNFP: calculateNFP };
})(typeof globalThis !== 'undefined' ? globalThis : this);
