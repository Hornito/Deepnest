/*
 * Geometry import dispatcher.
 *
 * Every supported format is normalised to an SVG string, which is what the
 * rest of Deepnest already understands. The heavy readers (OpenCascade for
 * STEP, LibreDWG for DWG) are dynamically imported so a user who only ever
 * opens SVG or DXF never downloads several megabytes of WebAssembly.
 */

import { dxfToSvg } from './dxf.js';

/* Extension -> how to read it. */
const FORMATS = {
  '.svg': { kind: 'svg', label: 'SVG' },
  '.dxf': { kind: 'dxf', label: 'DXF' },
  '.dwg': { kind: 'dwg', label: 'DWG' },
  '.step': { kind: 'step', label: 'STEP' },
  '.stp': { kind: 'step', label: 'STEP' },
  '.iges': { kind: 'step', label: 'IGES' },
  '.igs': { kind: 'step', label: 'IGES' },
};

export const ACCEPTED_EXTENSIONS = Object.keys(FORMATS);

export function extensionOf(filename) {
  const match = /\.[^.]+$/.exec(filename || '');
  return match ? match[0].toLowerCase() : '';
}

export function isSupported(filename) {
  return extensionOf(filename) in FORMATS;
}

/*
 * Read one file and return { svg, warnings, meta }.
 *
 * Warnings are things the user should know but that do not stop the import -
 * a DXF with no declared units, a STEP part that is not flat. They are
 * surfaced in the UI rather than thrown, because the import is still usable.
 */
export async function importFile(file) {
  const format = FORMATS[extensionOf(file.name)];

  if (!format) {
    throw new Error(
      `${file.name} is not a supported format. ` +
        `Open SVG, DXF, DWG, STEP or IGES files.`
    );
  }

  const warnings = [];

  switch (format.kind) {
    case 'svg': {
      const svg = await file.text();
      if (!/<svg[\s>]/i.test(svg)) {
        throw new Error(`${file.name} does not contain an SVG document.`);
      }
      return { svg, warnings, meta: { format: format.label } };
    }

    case 'dxf': {
      const text = await file.text();
      const result = dxfToSvg(text);
      if (!result.unitsKnown) {
        warnings.push(
          `${file.name} does not declare its units ($INSUNITS is unset), ` +
            `so it was imported as millimetres. Check the part size before cutting.`
        );
      }
      return {
        svg: result.svg,
        warnings,
        meta: { format: format.label, paths: result.polylineCount },
      };
    }

    case 'dwg': {
      const { dwgToSvg } = await import('./dwg.js');
      const buffer = await file.arrayBuffer();
      const result = await dwgToSvg(buffer);
      if (!result.unitsKnown) {
        warnings.push(
          `${file.name} does not declare its units, so it was imported as ` +
            `millimetres. Check the part size before cutting.`
        );
      }
      return {
        svg: result.svg,
        warnings,
        meta: { format: format.label, paths: result.polylineCount },
      };
    }

    case 'step': {
      const { stepToSvg } = await import('./step.js');
      const buffer = await file.arrayBuffer();
      const result = await stepToSvg(buffer, { filename: file.name });

      // A part that is mostly not in one plane has been projected rather than
      // unfolded, so its outline is a footprint. Say so - silently nesting a
      // bent part's footprint would waste a sheet.
      if (result.flatness < 0.25) {
        warnings.push(
          `${file.name} does not look like a flat part, so its outline is a ` +
            `projection of the 3D shape rather than a flat pattern. ` +
            `Unfold it in your CAD package first if it has bends.`
        );
      }

      return {
        svg: result.svg,
        warnings,
        meta: {
          format: format.label,
          // Offered to the material editor: the measured thickness of the
          // solid is usually the stock thickness the user wants.
          thickness: result.thickness,
          flatness: result.flatness,
          holes: result.holeCount,
        },
      };
    }

    default:
      throw new Error(`No reader for ${format.label}.`);
  }
}
