/*
 * Deepnest Web - application wiring.
 *
 * Holds the app state (parts, material, nest result), renders it, and connects
 * the UI to the importers, the material library and the nester.
 */

import { GeometryUtil } from './core/globals.js';
import { partsFromSvg, offsetPart } from './core/parts.js';
import { Nester, DEFAULT_CONFIG } from './core/nester.js';
import { importFile, isSupported } from './import/index.js';
import {
  MaterialLibrary,
  sheetPolygon,
  formatLength,
  parseLength,
  UNITS,
} from './material/materials.js';
import { nestToSvg, nestToDxf, download } from './export/index.js';

/*
 * Internal units per inch.
 *
 * SvgParser works in SVG user units and defaults to 72 per inch. Everything
 * physical is converted through this, so a part imported from a millimetre DXF
 * and one from an inch SVG end up the same size on the sheet.
 */
const UNITS_PER_INCH = 72;
const UNITS_PER_MM = UNITS_PER_INCH / 25.4;

const state = {
  parts: [],
  nest: null,
  displayUnit: 'mm',
  nester: null,
  nextPartId: 0,
};

const library = new MaterialLibrary();

const el = (id) => document.getElementById(id);

const ui = {
  dropzone: el('dropzone'),
  fileInput: el('file-input'),
  importBtn: el('import-btn'),
  partsList: el('parts-list'),
  partsEmpty: el('parts-empty'),
  materialSelect: el('material-select'),
  thickness: el('material-thickness'),
  kerf: el('material-kerf'),
  width: el('material-width'),
  height: el('material-height'),
  spacing: el('material-spacing'),
  saveMaterial: el('material-save'),
  deleteMaterial: el('material-delete'),
  rotations: el('opt-rotations'),
  useHoles: el('opt-holes'),
  concave: el('opt-concave'),
  start: el('nest-start'),
  stop: el('nest-stop'),
  exportSvg: el('export-svg'),
  exportDxf: el('export-dxf'),
  nestView: el('nest-view'),
  stats: el('nest-stats'),
  messages: el('messages'),
};

/* ------------------------------------------------------------------ *
 * Messages
 * ------------------------------------------------------------------ */

function message(text, kind = 'ok', persist = false) {
  const node = document.createElement('div');
  node.className = `message is-${kind}`;
  node.textContent = text;

  const close = document.createElement('button');
  close.className = 'message-close';
  close.type = 'button';
  close.textContent = '×';
  close.setAttribute('aria-label', 'Dismiss');
  close.onclick = () => node.remove();
  node.prepend(close);

  ui.messages.appendChild(node);

  // Errors and warnings stay until dismissed; they usually need acting on.
  if (!persist && kind === 'ok') {
    setTimeout(() => node.remove(), 4000);
  }

  return node;
}

/* ------------------------------------------------------------------ *
 * Import
 * ------------------------------------------------------------------ */

async function handleFiles(fileList) {
  const files = Array.from(fileList).filter((f) => {
    if (!isSupported(f.name)) {
      message(`${f.name}: unsupported format, skipped.`, 'warn', true);
      return false;
    }
    return true;
  });

  if (files.length === 0) {
    return;
  }

  const busy = message(`Importing ${files.length} file(s)…`, 'ok');
  busy.prepend(Object.assign(document.createElement('span'), {
    className: 'spinner',
  }));

  for (const file of files) {
    try {
      const result = await importFile(file);

      for (const warning of result.warnings) {
        message(warning, 'warn', true);
      }

      addPartsFromSvg(result.svg, file.name, result.meta);
    } catch (err) {
      message(`${file.name}: ${err.message}`, 'error', true);
    }
  }

  busy.remove();
  renderParts();
  updateButtons();
}

function addPartsFromSvg(svgString, filename, meta = {}) {
  const { parts } = partsFromSvg(svgString, {
    scale: UNITS_PER_INCH,
    curveTolerance: DEFAULT_CONFIG.curveTolerance,
    dxfFlag: meta.format === 'DXF' || meta.format === 'DWG',
  });

  if (parts.length === 0) {
    message(
      `${filename}: no closed outlines found. Parts must be closed paths.`,
      'warn',
      true
    );
    return;
  }

  parts.forEach((polygon, index) => {
    const bounds = GeometryUtil.getPolygonBounds(polygon);
    state.parts.push({
      id: state.nextPartId++,
      // Numbered within the file, not within the list: importing the same
      // drawing twice should name its parts the same way both times.
      name: parts.length > 1 ? `${filename} #${index + 1}` : filename,
      polygon,
      children: polygon.children || [],
      bounds,
      quantity: 1,
    });
  });

  // A STEP solid knows how thick it is, which is almost always the stock
  // thickness. Offer it rather than silently ignoring it.
  if (meta.thickness && meta.thickness > 0) {
    const current = library.selected;
    if (current && Math.abs(current.thickness - meta.thickness) > 0.01) {
      message(
        `${filename} is ${meta.thickness.toFixed(1)}mm thick; ` +
          `the selected material is ${current.thickness}mm.`,
        'warn',
        true
      );
    }
  }

  message(`${filename}: imported ${parts.length} part(s).`, 'ok');
}

/* ------------------------------------------------------------------ *
 * Parts UI
 * ------------------------------------------------------------------ */

function partThumbnail(part) {
  const { x, y, width, height } = part.bounds;
  const pad = Math.max(width, height) * 0.05;

  const ring = (points) =>
    points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ') + ' Z';

  const paths = [part.polygon, ...(part.children || [])]
    .map((poly) => `<path d="${ring(poly)}"/>`)
    .join('');

  return (
    `<svg class="part-thumb" viewBox="${x - pad} ${y - pad} ` +
    `${width + pad * 2} ${height + pad * 2}" preserveAspectRatio="xMidYMid meet">` +
    `${paths}</svg>`
  );
}

function renderParts() {
  ui.partsList.replaceChildren();
  ui.partsEmpty.hidden = state.parts.length > 0;

  for (const part of state.parts) {
    const row = document.createElement('div');
    row.className = 'part';
    row.setAttribute('role', 'listitem');

    const wMm = part.bounds.width / UNITS_PER_MM;
    const hMm = part.bounds.height / UNITS_PER_MM;

    row.innerHTML =
      partThumbnail(part) +
      `<div>` +
      `<div class="part-name" title="${escapeHtml(part.name)}">` +
      `${escapeHtml(part.name)}</div>` +
      `<div class="part-dims">${formatLength(wMm, state.displayUnit)} × ` +
      `${formatLength(hMm, state.displayUnit)}</div>` +
      `</div>`;

    const qty = document.createElement('input');
    qty.type = 'number';
    qty.min = '1';
    qty.step = '1';
    qty.value = String(part.quantity);
    qty.className = 'input part-qty';
    qty.setAttribute('aria-label', `Quantity of ${part.name}`);
    qty.onchange = () => {
      const n = Math.max(1, Math.floor(Number(qty.value) || 1));
      part.quantity = n;
      qty.value = String(n);
    };

    const remove = document.createElement('button');
    remove.className = 'part-remove';
    remove.type = 'button';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `Remove ${part.name}`);
    remove.onclick = () => {
      state.parts = state.parts.filter((p) => p !== part);
      renderParts();
      updateButtons();
    };

    row.append(qty, remove);
    ui.partsList.appendChild(row);
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/* ------------------------------------------------------------------ *
 * Material UI
 * ------------------------------------------------------------------ */

function renderMaterials() {
  ui.materialSelect.replaceChildren();

  for (const material of library.materials) {
    const option = document.createElement('option');
    option.value = material.id;
    option.textContent = `${material.name} — ${formatLength(
      material.sheetWidth,
      state.displayUnit
    )} × ${formatLength(material.sheetHeight, state.displayUnit)}`;
    option.selected = material.id === library.selectedId;
    ui.materialSelect.appendChild(option);
  }

  renderMaterialFields();
}

function renderMaterialFields() {
  const material = library.selected;
  if (!material) {
    return;
  }

  const conv = UNITS[state.displayUnit].perMm;
  const round = (mm) => Number((mm * conv).toFixed(state.displayUnit === 'inch' ? 3 : 2));

  ui.thickness.value = round(material.thickness);
  ui.kerf.value = round(material.kerf);
  ui.width.value = round(material.sheetWidth);
  ui.height.value = round(material.sheetHeight);
  ui.spacing.value = round(material.spacing);
}

/* Read the material fields back, converting from the display unit. */
function materialFromFields() {
  const read = (input) => parseLength(input.value, state.displayUnit);
  return {
    thickness: read(ui.thickness),
    kerf: read(ui.kerf),
    sheetWidth: read(ui.width),
    sheetHeight: read(ui.height),
    spacing: read(ui.spacing),
  };
}

function commitMaterialEdit() {
  const material = library.selected;
  if (!material) {
    return;
  }
  library.update(material.id, materialFromFields());
  renderMaterials();
}

/* ------------------------------------------------------------------ *
 * Nesting
 * ------------------------------------------------------------------ */

function nestConfig() {
  const material = library.selected;
  return {
    ...DEFAULT_CONFIG,
    rotations: Number(ui.rotations.value) || 4,
    useHoles: ui.useHoles.checked,
    exploreConcave: ui.concave.checked,
    // The nester works in internal units, the material in millimetres.
    spacing: (material?.spacing ?? 0) * UNITS_PER_MM,
  };
}

function startNest() {
  const material = library.selected;
  if (!material) {
    message('Select a material first.', 'error', true);
    return;
  }

  if (state.parts.length === 0) {
    message('Import at least one part first.', 'error', true);
    return;
  }

  const config = nestConfig();

  let sheet;
  try {
    sheet = sheetPolygon(material, UNITS_PER_MM);
  } catch (err) {
    message(err.message, 'error', true);
    return;
  }

  // Grow each part by half the spacing so the gap falls out of the geometry
  // rather than needing to be enforced during placement.
  const prepared = [];
  for (const part of state.parts) {
    const polygon =
      config.spacing > 0
        ? offsetPart(part.polygon, config.spacing, config.curveTolerance)
        : part.polygon;

    if (!polygon || polygon.length < 3) {
      message(
        `${part.name} disappears at ${material.spacing}mm spacing - reduce the spacing.`,
        'error',
        true
      );
      return;
    }

    // Reject parts that cannot fit the sheet in any rotation before spending
    // generations discovering it.
    const bounds = GeometryUtil.getPolygonBounds(polygon);
    const sheetBounds = GeometryUtil.getPolygonBounds(sheet);
    const fitsUpright =
      bounds.width <= sheetBounds.width && bounds.height <= sheetBounds.height;
    const fitsTurned =
      bounds.height <= sheetBounds.width && bounds.width <= sheetBounds.height;

    if (!fitsUpright && !fitsTurned) {
      message(
        `${part.name} is larger than the sheet ` +
          `(${formatLength(bounds.width / UNITS_PER_MM, state.displayUnit)} × ` +
          `${formatLength(bounds.height / UNITS_PER_MM, state.displayUnit)}).`,
        'error',
        true
      );
      return;
    }

    prepared.push({
      id: part.id,
      source: part.id,
      quantity: part.quantity,
      polygon,
      children: polygon.children || [],
    });
  }

  state.nest = null;
  ui.nestView.replaceChildren();
  ui.stats.textContent = 'starting…';

  state.nester = new Nester({
    config,
    onResult: (placement, info) => {
      state.nest = placement;
      renderNest(placement, material);
      updateStats(placement, info);
      updateButtons();
    },
    onProgress: (info) => {
      if (!state.nest) {
        ui.stats.textContent = `generation ${info.generations}`;
      }
    },
    onError: (err) => {
      message(`Nesting failed: ${err.message}`, 'error', true);
      stopNest();
    },
  });

  state.nester.start(prepared, sheet);

  ui.start.disabled = true;
  ui.stop.disabled = false;
}

function stopNest() {
  if (state.nester) {
    state.nester.stop();
    state.nester = null;
  }
  ui.start.disabled = false;
  ui.stop.disabled = true;
}

/*
 * Area of each part in mm², holes excluded, keyed by part id.
 *
 * Measured on the part as imported rather than on the spacing-grown polygon
 * that actually gets placed: utilisation asks how much of the sheet leaves the
 * machine as parts, and the spacing around them is waste by definition.
 */
function partAreaIndexMm2() {
  const index = new Map();
  const perMm2 = UNITS_PER_MM * UNITS_PER_MM;

  for (const part of state.parts) {
    const outer = Math.abs(GeometryUtil.polygonArea(part.polygon));
    const holes = (part.children || []).reduce(
      (sum, child) => sum + Math.abs(GeometryUtil.polygonArea(child)),
      0
    );
    index.set(part.id, Math.max(0, outer - holes) / perMm2);
  }

  return index;
}

/* Part area landed on each sheet, in mm². */
function sheetUsageMm2(placement, areaById) {
  return placement.placements.map((sheet) =>
    sheet.reduce((sum, entry) => sum + (areaById.get(entry.source) || 0), 0)
  );
}

function updateStats(placement, info) {
  const material = library.selected;
  const sheets = placement.placements.length;
  const placed = placement.placements.reduce((n, s) => n + s.length, 0);
  const total = state.parts.reduce((n, p) => n + p.quantity, 0);

  // Utilisation is the number this whole app exists to move: it is what
  // decides how much stock a job eats, so it belongs on screen next to the
  // sheet count rather than left for the user to work out.
  const sheetArea = material ? material.sheetWidth * material.sheetHeight : 0;
  const used = sheetUsageMm2(placement, partAreaIndexMm2());
  const usedTotal = used.reduce((a, b) => a + b, 0);
  const utilisation =
    sheetArea > 0 && sheets > 0 ? usedTotal / (sheets * sheetArea) : 0;

  ui.stats.innerHTML =
    `<span><strong>${sheets}</strong> sheet${sheets === 1 ? '' : 's'}</span>` +
    `<span><strong>${placed}</strong>/${total} placed</span>` +
    `<span title="Part area as a share of the sheets used">` +
    `<strong>${(utilisation * 100).toFixed(1)}%</strong> used</span>` +
    `<span>gen <strong>${info?.generations ?? 0}</strong></span>`;
}

/*
 * Draw the nest.
 *
 * Rendered from the same placement maths the exporter uses, so what is on
 * screen is what lands in the file.
 */
function renderNest(placement, material) {
  const partsById = new Map(state.parts.map((p) => [p.id, p]));
  ui.nestView.replaceChildren();

  const widthMm = material.sheetWidth;
  const heightMm = material.sheetHeight;
  const sheetArea = widthMm * heightMm;

  // Per sheet, so it is obvious at a glance which ones are worth cutting and
  // which are the thin tail the nest could not fill.
  const used = sheetUsageMm2(placement, partAreaIndexMm2());

  placement.placements.forEach((sheetPlacements, index) => {
    const wrap = document.createElement('div');
    wrap.className = 'sheet-wrap';

    const utilisation = sheetArea > 0 ? (used[index] / sheetArea) * 100 : 0;

    const label = document.createElement('p');
    label.className = 'sheet-label';
    label.textContent =
      `Sheet ${index + 1} — ${material.name}, ` +
      `${formatLength(material.thickness, state.displayUnit)} thick — ` +
      `${sheetPlacements.length} part${sheetPlacements.length === 1 ? '' : 's'}, ` +
      `${utilisation.toFixed(1)}% used`;

    const rings = [];
    for (const p of sheetPlacements) {
      // Keyed by source: `id` identifies the placed INSTANCE, and six copies
      // of one part are six distinct instance ids sharing one source.
      const part = partsById.get(p.source);
      if (!part) {
        continue;
      }
      const angle = ((p.rotation || 0) * Math.PI) / 180;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const place = (poly) =>
        poly.map((pt) => ({
          x: (pt.x * cos - pt.y * sin + p.x) / UNITS_PER_MM,
          y: (pt.x * sin + pt.y * cos + p.y) / UNITS_PER_MM,
        }));

      rings.push(place(part.polygon));
      for (const child of part.children || []) {
        rings.push(place(child));
      }
    }

    const paths = rings
      .map(
        (points) =>
          `<path d="${points
            .map(
              (pt, i) =>
                `${i === 0 ? 'M' : 'L'}${pt.x.toFixed(2)},${pt.y.toFixed(2)}`
            )
            .join(' ')} Z" fill="#4f9cf9" fill-opacity="0.18" ` +
          `stroke="#1b4b80" stroke-width="0.6"/>`
      )
      .join('');

    wrap.innerHTML =
      `<svg class="sheet" viewBox="0 0 ${widthMm} ${heightMm}" ` +
      `width="${widthMm}" height="${heightMm}" ` +
      `preserveAspectRatio="xMinYMin meet">${paths}</svg>`;

    wrap.prepend(label);
    ui.nestView.appendChild(wrap);
  });
}

/* ------------------------------------------------------------------ *
 * Export
 * ------------------------------------------------------------------ */

function exportNest(format) {
  if (!state.nest) {
    return;
  }
  const material = library.selected;
  const partsById = new Map(state.parts.map((p) => [p.id, p]));
  const stamp = new Date().toISOString().slice(0, 10);
  const safeName = material.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase();

  if (format === 'svg') {
    download(
      `nest-${safeName}-${stamp}.svg`,
      nestToSvg(state.nest, partsById, material, UNITS_PER_MM),
      'image/svg+xml'
    );
  } else {
    download(
      `nest-${safeName}-${stamp}.dxf`,
      nestToDxf(state.nest, partsById, material, UNITS_PER_MM),
      'application/dxf'
    );
  }
}

function updateButtons() {
  const hasNest = !!state.nest;
  ui.exportSvg.disabled = !hasNest;
  ui.exportDxf.disabled = !hasNest;
  ui.start.disabled = state.parts.length === 0 || !!state.nester;
}

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */

ui.importBtn.onclick = () => ui.fileInput.click();
ui.dropzone.onclick = () => ui.fileInput.click();

ui.fileInput.onchange = () => {
  if (ui.fileInput.files?.length) {
    handleFiles(ui.fileInput.files);
    // Reset so re-picking the same file fires change again.
    ui.fileInput.value = '';
  }
};

for (const type of ['dragenter', 'dragover']) {
  ui.dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    ui.dropzone.classList.add('is-over');
  });
}

for (const type of ['dragleave', 'drop']) {
  ui.dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    ui.dropzone.classList.remove('is-over');
  });
}

ui.dropzone.addEventListener('drop', (event) => {
  if (event.dataTransfer?.files?.length) {
    handleFiles(event.dataTransfer.files);
  }
});

// Dropping anywhere but the dropzone would otherwise navigate away from the
// app and lose the session.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

ui.materialSelect.onchange = () => {
  library.select(ui.materialSelect.value);
  renderMaterialFields();
};

for (const input of [ui.thickness, ui.kerf, ui.width, ui.height, ui.spacing]) {
  input.onchange = commitMaterialEdit;
}

ui.saveMaterial.onclick = () => {
  const name = prompt('Name for this material:', library.selected?.name ?? '');
  if (!name) {
    return;
  }
  library.add({ ...library.selected, ...materialFromFields(), name, id: null });
  renderMaterials();
  message(`Saved "${name}".`, 'ok');
};

ui.deleteMaterial.onclick = () => {
  const material = library.selected;
  if (!material) {
    return;
  }
  if (!confirm(`Delete "${material.name}"?`)) {
    return;
  }
  library.remove(material.id);
  renderMaterials();
};

for (const button of document.querySelectorAll('.unit-btn')) {
  button.onclick = () => {
    state.displayUnit = button.dataset.unit;
    for (const other of document.querySelectorAll('.unit-btn')) {
      other.classList.toggle('is-active', other === button);
    }
    renderMaterials();
    renderParts();
  };
}

ui.start.onclick = startNest;
ui.stop.onclick = stopNest;
ui.exportSvg.onclick = () => exportNest('svg');
ui.exportDxf.onclick = () => exportNest('dxf');

// A nest can run for minutes; losing it to a stray refresh is worth a prompt.
window.addEventListener('beforeunload', (event) => {
  if (state.nester || state.nest) {
    event.preventDefault();
    event.returnValue = '';
  }
});

renderMaterials();
renderParts();
updateButtons();
