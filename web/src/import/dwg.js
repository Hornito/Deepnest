/*
 * DWG import.
 *
 * DWG is AutoCAD's closed binary format with no public specification. The only
 * credible open reader is GNU LibreDWG, which is C - so this uses a
 * WebAssembly build of it.
 *
 * Rather than walk LibreDWG's entity tree, we use its DWG -> DXF writer and
 * hand the result to the DXF importer. That reuses every bit of geometry
 * handling already tested there (bulges, blocks, splines, units) instead of
 * duplicating it against a second, less-documented API.
 *
 * The WASM is ~3MB, so it is imported dynamically: opening SVG or DXF files
 * never pays for it.
 */

import { dxfToSvg } from './dxf.js';

let libredwgPromise = null;

/*
 * LibreDWG's WASM module is expensive to instantiate and safe to reuse, so
 * keep exactly one instance per page. The promise is cached rather than the
 * instance so concurrent imports share a single load.
 */
function loadLibreDwg() {
  if (!libredwgPromise) {
    libredwgPromise = import('@mlightcad/libredwg-web')
      .then(({ LibreDwg }) => LibreDwg.create())
      .catch((err) => {
        // Clear the cache so a transient failure (offline, blocked WASM) can
        // be retried by opening the file again.
        libredwgPromise = null;
        throw new Error(
          `Could not load the DWG reader: ${err.message}. ` +
            `DWG support needs WebAssembly - check that it is not blocked.`
        );
      });
  }
  return libredwgPromise;
}

/*
 * Convert DWG bytes to an SVG string.
 *
 * `buffer` is an ArrayBuffer, since DWG is binary and must not be read as text.
 */
export async function dwgToSvg(buffer) {
  const libredwg = await loadLibreDwg();

  let dxfBytes;
  try {
    dxfBytes = libredwg.dwg_write_dxf(buffer);
  } catch (err) {
    throw new Error(`Could not read this DWG file: ${err.message}`);
  }

  if (!dxfBytes || dxfBytes.length === 0) {
    throw new Error(
      'Could not read this DWG file. It may be corrupt, or a newer format ' +
        'than the reader supports - re-saving it as DXF from your CAD package ' +
        'will import correctly.'
    );
  }

  const dxfText = new TextDecoder('utf-8', { fatal: false }).decode(dxfBytes);

  const result = dxfToSvg(dxfText);
  return { ...result, via: 'dwg->dxf' };
}
