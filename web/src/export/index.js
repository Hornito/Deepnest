/*
 * Nest export.
 *
 * Two formats, because they get used differently:
 *
 *  - SVG for anything that reads vector art, and for eyeballing the result.
 *  - DXF for machine control, since that is what most CAM and cutter software
 *    actually ingests.
 *
 * Both write one sheet per output so a shop can cut them one at a time, and
 * both carry the material and thickness in a header comment - a nest is not
 * much use if nobody can tell what stock it was cut for.
 */

/*
 * Placements come back from the nester in the app's internal units. Export in
 * millimetres, which is unambiguous, and let the DXF declare it via $INSUNITS.
 */
function toMm(value, unitsPerMm) {
  return value / unitsPerMm;
}

/*
 * Transform a part's polygon by its placement (rotation then translation).
 * Mirrors what the placement worker did internally when it scored the nest.
 */
function placedPoints(polygon, placement) {
  const angle = ((placement.rotation || 0) * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);

  return polygon.map((p) => ({
    x: p.x * cos - p.y * sin + placement.x,
    y: p.x * sin + p.y * cos + placement.y,
  }));
}

/*
 * Every ring in a nest: outlines and holes, already transformed into sheet
 * coordinates. Both exporters work from this, so they cannot disagree about
 * where a part ended up.
 */
function ringsForSheet(sheetPlacements, partsById) {
  const rings = [];

  for (const placement of sheetPlacements) {
    // `source` is the part; `id` is the individual copy of it.
    const part = partsById.get(placement.source);
    if (!part) {
      continue;
    }

    rings.push({ points: placedPoints(part.polygon, placement), hole: false });

    for (const child of part.children || []) {
      rings.push({ points: placedPoints(child, placement), hole: true });
    }
  }

  return rings;
}

export function nestToSvg(nest, partsById, material, unitsPerMm) {
  const widthMm = material.sheetWidth;
  const heightMm = material.sheetHeight;

  const sheets = nest.placements
    .map((sheetPlacements, index) => {
      const rings = ringsForSheet(sheetPlacements, partsById);

      const paths = rings
        .map((ring) => {
          const d =
            ring.points
              .map(
                (p, i) =>
                  `${i === 0 ? 'M' : 'L'}${fmt(toMm(p.x, unitsPerMm))},` +
                  `${fmt(toMm(p.y, unitsPerMm))}`
              )
              .join(' ') + ' Z';
          return `    <path d="${d}"/>`;
        })
        .join('\n');

      // Sheets are stacked vertically with a gap, so one file shows the whole
      // job while each sheet stays separable.
      const offsetY = index * (heightMm + 20);

      return (
        `  <g transform="translate(0 ${fmt(offsetY)})">\n` +
        `    <rect x="0" y="0" width="${fmt(widthMm)}" height="${fmt(heightMm)}" ` +
        `fill="none" stroke="#bbb" stroke-width="0.5"/>\n` +
        `${paths}\n` +
        `  </g>`
      );
    })
    .join('\n');

  const totalHeight =
    nest.placements.length * heightMm + (nest.placements.length - 1) * 20;

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<!-- Deepnest Web nest\n` +
    `     Material: ${material.name}\n` +
    `     Thickness: ${material.thickness}mm\n` +
    `     Sheet: ${widthMm} x ${heightMm}mm\n` +
    `     Sheets used: ${nest.placements.length}\n` +
    `     Units: millimetres -->\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" ` +
    `width="${fmt(widthMm)}mm" height="${fmt(totalHeight)}mm" ` +
    `viewBox="0 0 ${fmt(widthMm)} ${fmt(totalHeight)}" ` +
    `fill="none" stroke="#000" stroke-width="0.2">\n` +
    `${sheets}\n` +
    `</svg>\n`
  );
}

/*
 * Minimal DXF R12.
 *
 * R12 is deliberate: it is the most widely readable DXF revision, and every
 * cutter and CAM package handles it. Parts are written as closed POLYLINEs
 * rather than LWPOLYLINE because R12 predates the lightweight entity.
 */
export function nestToDxf(nest, partsById, material, unitsPerMm) {
  const out = [];
  const pair = (code, value) => out.push(String(code), String(value));

  pair(999, `Deepnest Web - ${material.name} ${material.thickness}mm`);

  pair(0, 'SECTION');
  pair(2, 'HEADER');
  // 4 = millimetres, so the receiving package scales the part correctly.
  pair(9, '$INSUNITS');
  pair(70, 4);
  pair(0, 'ENDSEC');

  pair(0, 'SECTION');
  pair(2, 'ENTITIES');

  nest.placements.forEach((sheetPlacements, index) => {
    const layer = `SHEET_${index + 1}`;
    const offsetY = index * (material.sheetHeight + 20);

    for (const ring of ringsForSheet(sheetPlacements, partsById)) {
      pair(0, 'POLYLINE');
      pair(8, layer);
      pair(66, 1);
      pair(70, 1); // closed
      pair(10, 0);
      pair(20, 0);
      pair(30, 0);

      for (const p of ring.points) {
        pair(0, 'VERTEX');
        pair(8, layer);
        pair(10, fmt(toMm(p.x, unitsPerMm)));
        // DXF is Y-up; the nest is Y-down. Flip about the sheet.
        pair(20, fmt(material.sheetHeight - toMm(p.y, unitsPerMm) + offsetY));
        pair(30, 0);
      }

      pair(0, 'SEQEND');
      pair(8, layer);
    }
  });

  pair(0, 'ENDSEC');
  pair(0, 'EOF');

  return out.join('\n') + '\n';
}

function fmt(n) {
  return String(Math.round(n * 1e4) / 1e4);
}

/* Hand the file to the browser as a download. */
export function download(filename, contents, mime) {
  const blob = new Blob([contents], { type: mime });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();

  // Revoke on the next turn: revoking synchronously can cancel the download
  // in some browsers before it has started reading the blob.
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
