/*
 * Material library.
 *
 * The desktop app has no concept of a material: you draw a rectangle, mark it
 * as "the sheet", and every dimension lives in whatever unit the SVG happened
 * to use. In practice a shop cuts from a known stock list, so this models that
 * directly - a material carries its thickness, its sheet size, and the cut
 * allowance the machine needs.
 *
 * Thickness does not affect a 2D nest, but it is what distinguishes 3mm ply
 * from 18mm ply on the same 2440x1220 sheet, and it is what a cut list has to
 * state. It is stored per material and carried through to the export.
 */

const STORAGE_KEY = 'deepnest.materials.v1';
const SELECTION_KEY = 'deepnest.materials.selected.v1';

export const UNITS = {
  mm: { label: 'mm', perMm: 1 },
  inch: { label: 'in', perMm: 1 / 25.4 },
};

/*
 * Stock sizes people actually buy. Dimensions are millimetres, because that is
 * the unit every one of these is specified in by its supplier - including the
 * imperial ply sheets, which are sold as 2440x1220 rather than 8'x4'.
 */
export const PRESETS = [
  {
    id: 'ply-18',
    name: 'Plywood 18mm',
    thickness: 18,
    sheetWidth: 2440,
    sheetHeight: 1220,
    spacing: 6,
    kerf: 3,
    note: 'Standard 8x4 sheet, router-cut',
  },
  {
    id: 'ply-12',
    name: 'Plywood 12mm',
    thickness: 12,
    sheetWidth: 2440,
    sheetHeight: 1220,
    spacing: 6,
    kerf: 3,
  },
  {
    id: 'mdf-3',
    name: 'MDF 3mm',
    thickness: 3,
    sheetWidth: 1220,
    sheetHeight: 610,
    spacing: 2,
    kerf: 0.2,
    note: 'Laser-cut, narrow kerf',
  },
  {
    id: 'acrylic-3',
    name: 'Acrylic 3mm',
    thickness: 3,
    sheetWidth: 1000,
    sheetHeight: 600,
    spacing: 2,
    kerf: 0.2,
  },
  {
    id: 'alu-2',
    name: 'Aluminium 2mm',
    thickness: 2,
    sheetWidth: 2000,
    sheetHeight: 1000,
    spacing: 4,
    kerf: 0.15,
  },
  {
    id: 'steel-1_5',
    name: 'Mild steel 1.5mm',
    thickness: 1.5,
    sheetWidth: 2500,
    sheetHeight: 1250,
    spacing: 4,
    kerf: 0.2,
  },
  {
    id: 'steel-3',
    name: 'Mild steel 3mm',
    thickness: 3,
    sheetWidth: 2500,
    sheetHeight: 1250,
    spacing: 6,
    kerf: 0.3,
  },
];

/*
 * A material is deliberately plain data so it round-trips through
 * localStorage and JSON export without a schema.
 *
 * All lengths are millimetres internally, whatever the display unit. Keeping
 * one canonical unit means a user switching mm/inch never rescales their
 * saved library.
 */
export function createMaterial(fields = {}) {
  return {
    id: fields.id || `mat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: fields.name || 'Untitled material',
    thickness: numberOr(fields.thickness, 3),
    sheetWidth: numberOr(fields.sheetWidth, 1000),
    sheetHeight: numberOr(fields.sheetHeight, 500),
    // Gap left between parts. This is the one that changes nesting output.
    spacing: numberOr(fields.spacing, 2),
    // Cutter width. Recorded for the cut list; it does not change placement.
    kerf: numberOr(fields.kerf, 0.2),
    note: fields.note || '',
  };
}

function numberOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export class MaterialLibrary {
  constructor(storage = globalThis.localStorage) {
    this.storage = storage;
    this.materials = this.load();
    this.selectedId = this.loadSelection();
  }

  load() {
    try {
      const raw = this.storage?.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed.map(createMaterial);
        }
      }
    } catch (err) {
      // Corrupt or unreadable storage must not stop the app from opening -
      // fall through to the presets and let the user carry on.
      console.warn('Could not read the saved material library:', err);
    }
    return PRESETS.map(createMaterial);
  }

  loadSelection() {
    try {
      const id = this.storage?.getItem(SELECTION_KEY);
      if (id && this.materials.some((m) => m.id === id)) {
        return id;
      }
    } catch (err) {
      /* fall through to the first material */
    }
    return this.materials[0]?.id ?? null;
  }

  save() {
    try {
      this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.materials));
      if (this.selectedId) {
        this.storage?.setItem(SELECTION_KEY, this.selectedId);
      }
    } catch (err) {
      // Private browsing and full quotas both land here. The library still
      // works for this session; only persistence is lost.
      console.warn('Could not save the material library:', err);
    }
  }

  get selected() {
    return this.materials.find((m) => m.id === this.selectedId) ?? this.materials[0] ?? null;
  }

  select(id) {
    if (this.materials.some((m) => m.id === id)) {
      this.selectedId = id;
      this.save();
    }
  }

  add(fields) {
    const material = createMaterial(fields);
    this.materials.push(material);
    this.selectedId = material.id;
    this.save();
    return material;
  }

  update(id, fields) {
    const index = this.materials.findIndex((m) => m.id === id);
    if (index < 0) {
      return null;
    }
    // Preserve the id so edits do not orphan the current selection.
    this.materials[index] = createMaterial({ ...this.materials[index], ...fields, id });
    this.save();
    return this.materials[index];
  }

  remove(id) {
    const index = this.materials.findIndex((m) => m.id === id);
    if (index < 0) {
      return false;
    }
    this.materials.splice(index, 1);

    // Never leave the library empty: an empty stock list would mean no sheet,
    // and no way to nest.
    if (this.materials.length === 0) {
      this.materials = PRESETS.map(createMaterial);
    }
    if (this.selectedId === id) {
      this.selectedId = this.materials[0].id;
    }
    this.save();
    return true;
  }

  resetToPresets() {
    this.materials = PRESETS.map(createMaterial);
    this.selectedId = this.materials[0].id;
    this.save();
  }
}

/*
 * Build the sheet polygon the nester places parts into.
 *
 * `unitsPerMm` converts the material's millimetres into the app's internal
 * units, which are whatever the imported geometry used.
 *
 * The sheet is inset by half the part spacing on every side. Deepnest applies
 * spacing between parts by offsetting each part outward by spacing/2, so
 * without the matching inset a part would end up hanging half a spacing over
 * the edge of the sheet - and be cut short.
 */
export function sheetPolygon(material, unitsPerMm = 1) {
  const inset = (material.spacing ?? 0) / 2;

  const width = (material.sheetWidth - 2 * inset) * unitsPerMm;
  const height = (material.sheetHeight - 2 * inset) * unitsPerMm;

  if (!(width > 0) || !(height > 0)) {
    throw new Error(
      `Sheet is too small for ${material.spacing}mm spacing: ` +
        `${material.sheetWidth}x${material.sheetHeight}mm leaves no usable area.`
    );
  }

  return [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height },
  ];
}

/* Format a length held in millimetres for display in the chosen unit. */
export function formatLength(mm, unit = 'mm') {
  const conv = UNITS[unit] ?? UNITS.mm;
  const value = mm * conv.perMm;
  const decimals = unit === 'inch' ? 3 : 1;
  return `${Number(value.toFixed(decimals))}${conv.label}`;
}

/* Parse a user-entered length in the chosen unit back to millimetres. */
export function parseLength(value, unit = 'mm') {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return null;
  }
  const conv = UNITS[unit] ?? UNITS.mm;
  return n / conv.perMm;
}
