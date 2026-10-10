/*
 * STEP / IGES import.
 *
 * STEP is a 3D boundary-representation format, but nesting is a 2D problem:
 * what we need is the flat profile that will be cut out of a sheet. So this
 * importer loads the solid with OpenCascade (compiled to WASM), works out
 * which plane the part is flattest in, and projects its silhouette onto that
 * plane.
 *
 * That is exactly right for plate parts - anything laser-cut, waterjet-cut or
 * routed from flat stock, which is what Deepnest exists to nest. It is NOT a
 * sheet-metal unfolder: a part with bends is projected as it sits, so the
 * result is its footprint rather than its flat pattern. `flatness` is returned
 * so the UI can say so plainly instead of silently nesting the wrong shape.
 */

/*
 * Clipper is read off the global at call time rather than imported.
 *
 * In the browser it arrives via a <script> tag like the rest of the nesting
 * core. Reading it lazily keeps this module loadable outside a DOM, which is
 * what lets the projection maths be tested in Node against real STEP files.
 */
function clipper() {
  const lib = globalThis.ClipperLib;
  if (!lib) {
    throw new Error('ClipperLib is not loaded; cannot build a 2D profile.');
  }
  return lib;
}

// Clipper is integer-only; this matches the scale used elsewhere in the app.
const CLIPPER_SCALE = 10000000;

// A face is treated as "in plane" when its normal is within this angle of the
// dominant normal. 5 degrees tolerates tessellation noise on a real flat face
// without swallowing a genuine 10-degree bend.
const IN_PLANE_TOLERANCE = Math.cos((5 * Math.PI) / 180);

let occtPromise = null;

/*
 * Load the Emscripten module by injecting its script tag.
 *
 * The loader resolves its .wasm sibling relative to itself, which is why both
 * files are served verbatim from public/wasm (see scripts/sync-core.mjs) and
 * `locateFile` points back there. Bundling this module tends to break that
 * pairing.
 */
function loadOcct() {
  if (occtPromise) {
    return occtPromise;
  }

  occtPromise = new Promise((resolve, reject) => {
    const base = new URL('wasm/', document.baseURI).href;
    const script = document.createElement('script');
    script.src = `${base}occt-import-js.js`;
    script.async = true;

    script.onload = () => {
      if (typeof globalThis.occtimportjs !== 'function') {
        reject(new Error('The OpenCascade loader did not register itself.'));
        return;
      }
      globalThis
        .occtimportjs({ locateFile: (file) => `${base}${file}` })
        .then(resolve, reject);
    };

    script.onerror = () => {
      reject(
        new Error(
          'Could not load the STEP reader. Check that public/wasm was built - ' +
            'run `npm run sync-core`.'
        )
      );
    };

    document.head.appendChild(script);
  }).catch((err) => {
    // Allow a retry on the next import attempt.
    occtPromise = null;
    throw err;
  });

  return occtPromise;
}

/* ------------------------------------------------------------------ *
 * Geometry
 * ------------------------------------------------------------------ */

const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const cross = (a, b) => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const length = (a) => Math.sqrt(dot(a, a));

/*
 * Canonicalise a normal's sign so opposite faces of a plate agree.
 *
 * A plate's two big faces have normals n and -n. For "which plane is this part
 * flattest in" they are the same answer, so flip every normal into a
 * half-space: first non-zero component positive.
 */
function canonicalNormal(n) {
  const eps = 1e-9;
  const flip =
    n.x < -eps ||
    (Math.abs(n.x) <= eps && n.y < -eps) ||
    (Math.abs(n.x) <= eps && Math.abs(n.y) <= eps && n.z < 0);
  return flip ? { x: -n.x, y: -n.y, z: -n.z } : n;
}

/* Total surface area whose normal is parallel to `axis`, within tolerance. */
function areaAlong(triangles, axis) {
  let total = 0;
  for (const [a, b, c] of triangles) {
    const n = cross(sub(b, a), sub(c, a));
    const len = length(n);
    if (len < 1e-12) {
      continue;
    }
    if (Math.abs(dot(n, axis) / len) >= IN_PLANE_TOLERANCE) {
      total += len / 2;
    }
  }
  return total;
}

/*
 * Find the plane the part is flattest in: the normal direction carrying the
 * most face area.
 *
 * An earlier version accumulated the area-weighted outer product n(x)n and
 * took its dominant eigenvector. That is elegant but degenerate on exactly the
 * shapes people nest: for a cube - or any part with equal area on all three
 * axes - the matrix is a multiple of the identity, every direction is an
 * eigenvector, and power iteration never leaves its seed. The result was a
 * projection down the (1,1,1) diagonal, turning a 10mm cube into a 14.14mm
 * lozenge.
 *
 * So bucket the normals by direction instead and pick the heaviest, which
 * optimises the quantity we actually care about and has no degenerate case:
 * ties are broken arbitrarily but always land on a real face.
 */
function dominantNormal(triangles) {
  // Quantise directions onto a coarse grid so a flat face's triangles - whose
  // normals differ only by float noise - land in one bucket.
  const GRID = 0.01;
  const buckets = new Map();
  let totalArea = 0;

  for (const [a, b, c] of triangles) {
    const n = cross(sub(b, a), sub(c, a));
    const len = length(n);
    if (len < 1e-12) {
      continue;
    }

    const area = len / 2;
    totalArea += area;

    const unit = canonicalNormal({ x: n.x / len, y: n.y / len, z: n.z / len });
    const key =
      `${Math.round(unit.x / GRID)},` +
      `${Math.round(unit.y / GRID)},` +
      `${Math.round(unit.z / GRID)}`;

    const bucket = buckets.get(key);
    if (bucket) {
      bucket.area += area;
      bucket.sx += unit.x * area;
      bucket.sy += unit.y * area;
      bucket.sz += unit.z * area;
    } else {
      buckets.set(key, {
        area,
        sx: unit.x * area,
        sy: unit.y * area,
        sz: unit.z * area,
      });
    }
  }

  if (totalArea === 0 || buckets.size === 0) {
    return { normal: { x: 0, y: 0, z: 1 }, totalArea: 0 };
  }

  // A face whose normal straddles a grid boundary can split across two
  // buckets. Re-score the strongest few by their true in-plane area so that
  // splitting cannot cost a genuine flat face the win.
  const candidates = [...buckets.values()]
    .sort((a, b) => b.area - a.area)
    .slice(0, 8)
    .map((bucket) => {
      const len = Math.hypot(bucket.sx, bucket.sy, bucket.sz) || 1;
      return { x: bucket.sx / len, y: bucket.sy / len, z: bucket.sz / len };
    });

  let best = candidates[0];
  let bestArea = -1;
  for (const axis of candidates) {
    const area = areaAlong(triangles, axis);
    if (area > bestArea) {
      bestArea = area;
      best = axis;
    }
  }

  return { normal: best, totalArea };
}

/* An orthonormal basis for the plane perpendicular to `n`. */
function planeBasis(n) {
  // Pick the world axis least aligned with n so the cross product is stable.
  const away =
    Math.abs(n.x) < Math.abs(n.y) && Math.abs(n.x) < Math.abs(n.z)
      ? { x: 1, y: 0, z: 0 }
      : Math.abs(n.y) < Math.abs(n.z)
        ? { x: 0, y: 1, z: 0 }
        : { x: 0, y: 0, z: 1 };

  let u = cross(n, away);
  const ul = length(u);
  u = { x: u.x / ul, y: u.y / ul, z: u.z / ul };

  const v = cross(n, u);
  return { u, v };
}

/*
 * Union every projected triangle into the part silhouette.
 *
 * Triangles perpendicular to the projection plane - the walls of a through
 * hole, the edge of the plate - collapse to zero-area slivers and contribute
 * nothing, so holes survive the union rather than being filled in. That is
 * what makes this produce a cuttable profile and not just an outer envelope.
 */
function silhouette(triangles, u, v) {
  const ClipperLib = clipper();
  const clip = new ClipperLib.Clipper();
  let added = 0;

  for (const tri of triangles) {
    const path = tri.map(
      (p) =>
        new ClipperLib.IntPoint(
          Math.round(dot(p, u) * CLIPPER_SCALE),
          Math.round(dot(p, v) * CLIPPER_SCALE)
        )
    );

    // Drop degenerate projections before Clipper has to think about them.
    const area = Math.abs(ClipperLib.Clipper.Area(path));
    if (area < 1) {
      continue;
    }

    // Normalise winding so a single NonZero union means "covered by anything".
    if (!ClipperLib.Clipper.Orientation(path)) {
      path.reverse();
    }

    clip.AddPath(path, ClipperLib.PolyType.ptSubject, true);
    added++;
  }

  if (added === 0) {
    return [];
  }

  // A PolyTree keeps the outer/hole nesting, which plain Paths would lose.
  const tree = new ClipperLib.PolyTree();
  clip.Execute(
    ClipperLib.ClipType.ctUnion,
    tree,
    ClipperLib.PolyFillType.pftNonZero,
    ClipperLib.PolyFillType.pftNonZero
  );

  const rings = [];
  const walk = (node) => {
    for (const child of node.Childs()) {
      const contour = child.Contour();
      if (contour.length >= 3) {
        rings.push({
          points: contour.map((p) => ({
            x: p.X / CLIPPER_SCALE,
            y: p.Y / CLIPPER_SCALE,
          })),
          isHole: child.IsHole(),
        });
      }
      walk(child);
    }
  };
  walk(tree);

  return rings;
}

/* ------------------------------------------------------------------ *
 * Import
 * ------------------------------------------------------------------ */

/*
 * Read a STEP or IGES file and return an SVG of its flat profile.
 *
 * `buffer` is an ArrayBuffer of the file.
 */
export async function stepToSvg(buffer, { filename = '' } = {}) {
  const occt = await loadOcct();
  const bytes = new Uint8Array(buffer);

  const isIges = /\.ig[es]s?$/i.test(filename);

  // Ask OpenCascade for millimetres so downstream scaling has a known basis.
  // A finer deflection than the cut tolerance would only add points the
  // nester has to chew through.
  const params = {
    linearUnit: 'millimeter',
    linearDeflectionType: 'absolute_value',
    linearDeflection: 0.05,
    angularDeflection: 0.5,
  };

  let result;
  try {
    result = isIges
      ? occt.ReadIgesFile(bytes, params)
      : occt.ReadStepFile(bytes, params);
  } catch (err) {
    throw new Error(`Could not read this file: ${err.message}`);
  }

  if (!result || !result.success) {
    throw new Error(
      'OpenCascade could not read this file. It may be corrupt or use an ' +
        'unsupported STEP application protocol.'
    );
  }

  return profileFromMeshes(result.meshes);
}

/*
 * Turn OpenCascade's triangle meshes into a flat SVG profile.
 *
 * Split out from stepToSvg so the projection maths can be exercised directly
 * against real STEP fixtures without needing a DOM to load the WASM into.
 */
export function profileFromMeshes(meshes, { scale = 1 } = {}) {
  // Flatten every mesh into world-space triangles.
  const triangles = [];
  for (const mesh of meshes || []) {
    const pos = mesh.attributes?.position?.array;
    const idx = mesh.index?.array;
    if (!pos || !idx) {
      continue;
    }
    for (let i = 0; i + 2 < idx.length; i += 3) {
      const tri = [];
      for (let k = 0; k < 3; k++) {
        const o = idx[i + k] * 3;
        tri.push({ x: pos[o], y: pos[o + 1], z: pos[o + 2] });
      }
      triangles.push(tri);
    }
  }

  if (triangles.length === 0) {
    throw new Error('This file contains no solid geometry to nest.');
  }

  const { normal, totalArea } = dominantNormal(triangles);
  const { u, v } = planeBasis(normal);

  // How much of the surface actually lies in the chosen plane, and how thick
  // the part is along the normal. Together these say whether the projection
  // is the part's true profile or merely its footprint.
  const inPlaneArea = areaAlong(triangles, normal);

  let minN = Infinity;
  let maxN = -Infinity;
  for (const tri of triangles) {
    for (const p of tri) {
      const d = dot(p, normal);
      if (d < minN) minN = d;
      if (d > maxN) maxN = d;
    }
  }

  const rings = silhouette(triangles, u, v);
  if (rings.length === 0) {
    throw new Error('Could not derive a 2D profile from this file.');
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const ring of rings) {
    for (const p of ring.points) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
  }

  // OpenCascade was asked for millimetres, so these already are.
  const width = (maxX - minX) * scale;
  const height = (maxY - minY) * scale;
  const fmt = (n) => (Math.round(n * 1e6) / 1e6).toString();

  // Emit outer rings and holes as one path each, using fill-rule evenodd so
  // SvgParser reads the holes as holes.
  const d = rings
    .map(
      (ring) =>
        ring.points
          .map((p, i) => {
            const x = (p.x - minX) * scale;
            const y = (maxY - p.y) * scale;
            return `${i === 0 ? 'M' : 'L'}${fmt(x)},${fmt(y)}`;
          })
          .join(' ') + ' Z'
    )
    .join(' ');

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" ` +
    `width="${fmt(width)}mm" height="${fmt(height)}mm" ` +
    `viewBox="0 0 ${fmt(width)} ${fmt(height)}">\n` +
    `  <path d="${d}" fill-rule="evenodd" fill="none" stroke="#000" stroke-width="0.1"/>\n` +
    `</svg>`;

  const flatness = totalArea > 0 ? inPlaneArea / totalArea : 0;
  const thickness = maxN - minN;

  return {
    svg,
    // Fraction of surface area lying in the projection plane. Near 1 means a
    // genuine flat plate; low values mean the projection is a footprint.
    flatness,
    // Extent along the projection normal, in millimetres - the part's
    // thickness for a plate, and a good default for the material thickness.
    thickness,
    ringCount: rings.length,
    holeCount: rings.filter((r) => r.isHole).length,
    unitsKnown: true,
  };
}
