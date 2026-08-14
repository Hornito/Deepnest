/*
 * End-to-end check in a real browser.
 *
 * The unit tests cover the geometry, but they cannot prove the app actually
 * runs: that the classic core scripts register, that the Web Worker boots and
 * imports them, and that a nest completes and exports. That is what this does,
 * by driving the built app in headless Chromium.
 *
 * Usage: node test/e2e.mjs [baseUrl]
 */

import { chromium } from 'playwright';
import { existsSync, writeFileSync } from 'node:fs';

const BASE = process.argv[2] || 'http://localhost:4173';

/* A DXF with an outer rectangle and two round holes: enough to exercise
 * closed-path detection, hole nesting and curve tessellation at once. */
function makeDxf() {
  const pairs = [];
  const add = (c, v) => pairs.push(`${c}\n${v}`);

  add(0, 'SECTION');
  add(2, 'HEADER');
  add(9, '$INSUNITS');
  add(70, '4');
  add(0, 'ENDSEC');
  add(0, 'SECTION');
  add(2, 'ENTITIES');

  // 120 x 80 mm plate
  add(0, 'LWPOLYLINE');
  add(8, '0');
  add(90, '4');
  add(70, '1');
  for (const [x, y] of [
    [0, 0],
    [120, 0],
    [120, 80],
    [0, 80],
  ]) {
    add(10, x.toFixed(1));
    add(20, y.toFixed(1));
  }

  // two 20mm-diameter holes
  for (const [cx, cy] of [
    [30, 40],
    [90, 40],
  ]) {
    add(0, 'CIRCLE');
    add(8, '0');
    add(10, cx.toFixed(1));
    add(20, cy.toFixed(1));
    add(40, '10.0');
  }

  add(0, 'ENDSEC');
  add(0, 'EOF');

  return pairs.join('\n') + '\n';
}

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

/*
 * Prefer a Chromium already on the machine over one Playwright wants to
 * download: CI images and sandboxes commonly ship one at a fixed path, and the
 * revision Playwright expects rarely matches it.
 */
function chromiumPath() {
  if (process.env.CHROMIUM_PATH) {
    return process.env.CHROMIUM_PATH;
  }
  for (const candidate of [
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    '/opt/pw-browsers/chromium/chrome-linux/chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
  ]) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

const browser = await chromium.launch({
  executablePath: chromiumPath(),
  // The sandbox needs kernel privileges this container does not grant, and
  // the page under test is a local build.
  args: ['--no-sandbox'],
});
const page = await browser.newPage();

const consoleErrors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') {
    consoleErrors.push(msg.text());
  }
});
const failedRequests = [];
page.on('requestfailed', (req) =>
  failedRequests.push(`${req.url()} (${req.failure()?.errorText})`)
);
page.on('response', (res) => {
  if (res.status() >= 400) {
    failedRequests.push(`${res.url()} -> ${res.status()}`);
  }
});
page.on('pageerror', (err) => consoleErrors.push(String(err)));

await page.goto(BASE, { waitUntil: 'networkidle' });

// --- core scripts registered -------------------------------------------
const globals = await page.evaluate(() => ({
  clipper: typeof window.ClipperLib,
  geometry: typeof window.GeometryUtil,
  parser: typeof window.SvgParser,
  simplify: typeof window.simplify,
  hull: typeof window.ConvexHullGrahamScan,
}));

check(
  'nesting core scripts register on window',
  Object.values(globals).every((t) => t === 'object' || t === 'function'),
  JSON.stringify(globals)
);

// --- material library ---------------------------------------------------
const materialCount = await page.locator('#material-select option').count();
check('material presets are loaded', materialCount > 0, `${materialCount} materials`);

// --- import a DXF -------------------------------------------------------
await page.setInputFiles('#file-input', {
  name: 'plate.dxf',
  mimeType: 'application/dxf',
  buffer: Buffer.from(makeDxf(), 'utf8'),
});

await page.waitForSelector('.part', { timeout: 20000 });
const partCount = await page.locator('.part').count();
check('DXF import produces a part', partCount === 1, `${partCount} part(s)`);

const dims = await page.locator('.part-dims').first().textContent();
check(
  'imported part has the drawing size',
  /120/.test(dims) && /80/.test(dims),
  dims?.trim()
);

// --- set a material and sheet size --------------------------------------
await page.fill('#material-width', '600');
await page.fill('#material-height', '400');
await page.fill('#material-thickness', '6');
await page.fill('#material-spacing', '4');
await page.dispatchEvent('#material-spacing', 'change');

// Ask for several copies so the nester has real work to do.
await page.fill('.part-qty', '6');
await page.dispatchEvent('.part-qty', 'change');

// --- run the nest -------------------------------------------------------
await page.click('#nest-start');

// The worker has to boot, importScripts the core, build NFPs and place.
await page.waitForSelector('.sheet', { timeout: 120000 });

const sheetCount = await page.locator('.sheet').count();
check('nest produced at least one sheet', sheetCount >= 1, `${sheetCount} sheet(s)`);

const placed = await page.locator('.sheet path').count();
check(
  'parts were placed on the sheet',
  placed > 0,
  `${placed} rings drawn (outlines + holes)`
);

// The test plate is one outline plus two holes, and six copies were asked
// for, so a correct render draws 18 rings. Anything less means placements
// were dropped - which is exactly what happens if placed instances cannot be
// mapped back to the part they came from.
check(
  'every requested copy is drawn, with its holes',
  placed === 18,
  `${placed} rings drawn, expected 18 (6 copies x (1 outline + 2 holes))`
);

const stats = await page.locator('#nest-stats').textContent();
check('nest reports statistics', /placed/.test(stats || ''), stats?.trim());

// --- placements must be inside the sheet and not overlap ----------------
const geometry = await page.evaluate(() => {
  const svg = document.querySelector('.sheet');
  const vb = svg.getAttribute('viewBox').split(' ').map(Number);
  const paths = [...svg.querySelectorAll('path')].map((p) => {
    const nums = p
      .getAttribute('d')
      .match(/-?\d+(\.\d+)?/g)
      .map(Number);
    const xs = nums.filter((_, i) => i % 2 === 0);
    const ys = nums.filter((_, i) => i % 2 === 1);
    return {
      minX: Math.min(...xs),
      maxX: Math.max(...xs),
      minY: Math.min(...ys),
      maxY: Math.max(...ys),
    };
  });
  return { viewBox: vb, paths };
});

const [, , sheetW, sheetH] = geometry.viewBox;
const outside = geometry.paths.filter(
  (b) =>
    b.minX < -0.5 || b.minY < -0.5 || b.maxX > sheetW + 0.5 || b.maxY > sheetH + 0.5
);
check(
  'every placed part lies within the sheet',
  outside.length === 0,
  outside.length ? `${outside.length} part(s) hang off the sheet` : `sheet ${sheetW}x${sheetH}mm`
);

await page.click('#nest-stop');

// --- export -------------------------------------------------------------
for (const [button, extension] of [
  ['#export-svg', '.svg'],
  ['#export-dxf', '.dxf'],
]) {
  const [downloadEvent] = await Promise.all([
    page.waitForEvent('download', { timeout: 15000 }),
    page.click(button),
  ]);
  const name = downloadEvent.suggestedFilename();
  check(`export produces a ${extension} file`, name.endsWith(extension), name);

  if (extension === '.dxf') {
    const stream = await downloadEvent.createReadStream();
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf8');
    check(
      'exported DXF declares millimetre units',
      /\$INSUNITS\n\s*70\n\s*4/.test(text),
      ''
    );
    check(
      'exported DXF contains polyline geometry',
      /POLYLINE/.test(text) && /VERTEX/.test(text),
      ''
    );
  }
}

// --- no console errors --------------------------------------------------
const realErrors = consoleErrors.filter(
  // favicon 404s are noise, not failures
  (e) => !/favicon/i.test(e)
);
check(
  'no console errors during the run',
  realErrors.length === 0,
  realErrors.slice(0, 3).join(' | ')
);

const realFailures = failedRequests.filter((u) => !/favicon/i.test(u));
check(
  'no failed network requests',
  realFailures.length === 0,
  realFailures.slice(0, 3).join(' | ')
);

await page.screenshot({ path: 'test/e2e-screenshot.png', fullPage: false });
writeFileSync(
  'test/e2e-results.json',
  JSON.stringify({ results, consoleErrors: realErrors }, null, 2)
);

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
