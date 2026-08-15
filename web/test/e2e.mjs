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
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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

// --- console must be clean for the whole nest/export path ---------------
// Checked here rather than at the very end: the WASM importer tests below
// deliberately feed a corrupt file in, and Emscripten logs its own diagnostics
// to console.error when it rejects one. Those are expected, so the strict
// check covers everything up to this point.
const realErrors = consoleErrors.filter(
  // favicon 404s are noise, not failures
  (e) => !/favicon/i.test(e)
);
check(
  'no console errors during the run',
  realErrors.length === 0,
  realErrors.slice(0, 3).join(' | ')
);

// --- STEP import, through the real WASM ---------------------------------
// The unit tests exercise the projection maths directly, but they cannot
// prove the 7.6MB OpenCascade build actually loads: it is fetched through an
// injected <script> tag and resolves its own .wasm sibling, which is exactly
// the arrangement bundlers tend to break. So load a real STEP solid of known
// size and check the part that comes out.
const stepFixture = join(
  'node_modules',
  'occt-import-js',
  'test',
  'testfiles',
  'cube-10x10mm',
  'Cube 10x10.stp'
);

if (existsSync(stepFixture)) {
  const partsBefore = await page.locator('.part').count();

  await page.setInputFiles('#file-input', {
    name: 'cube.step',
    mimeType: 'application/step',
    buffer: readFileSync(stepFixture),
  });

  // Loading and instantiating OpenCascade takes a moment on first use.
  await page
    .waitForFunction(
      (before) => document.querySelectorAll('.part').length > before,
      partsBefore,
      { timeout: 120000 }
    )
    .catch(() => {});

  const partsAfter = await page.locator('.part').count();
  check('STEP import produces a part', partsAfter === partsBefore + 1, `${partsAfter} part(s)`);

  if (partsAfter > partsBefore) {
    const stepDims = await page.locator('.part-dims').last().textContent();
    // A 10mm cube must project to a 10x10mm square. Getting the plane wrong
    // gives 14.14mm (the face diagonal), which is the failure this catches.
    check(
      'STEP part projects to its true 10x10mm size',
      /\b10(\.\d)?mm\b/.test(stepDims || '') &&
        !/14\.1/.test(stepDims || ''),
      stepDims?.trim()
    );
  }
} else {
  check('STEP fixture available', false, `missing ${stepFixture}`);
}

// --- DWG reader loads and fails safely ----------------------------------
// No DWG fixture ships with LibreDWG, and its WASM build is read-only so one
// cannot be synthesised here. What can still be verified is the part this
// repo owns: that the reader loads at all, and that a file it cannot read
// produces an actionable message instead of an unhandled rejection. The
// DWG->DXF conversion itself is LibreDWG's and is tested upstream.
const errorsBeforeDwg = consoleErrors.length;

await page.setInputFiles('#file-input', {
  name: 'broken.dwg',
  mimeType: 'image/vnd.dwg',
  // A plausible DWG magic followed by noise: enough to get past extension
  // dispatch and into the reader.
  buffer: Buffer.concat([
    Buffer.from('AC1027', 'ascii'),
    Buffer.alloc(512, 0x7f),
  ]),
});

// Pull out the one message about this file rather than scanning the whole
// panel, which still holds the DXF and STEP notices from earlier.
const dwgMessage = await page
  .waitForFunction(
    () => {
      const node = [...document.querySelectorAll('#messages .message')].find(
        (m) => m.textContent.includes('broken.dwg')
      );
      return node ? node.textContent.replace(/^×\s*/, '') : null;
    },
    undefined,
    { timeout: 120000 }
  )
  .then((handle) => handle.jsonValue())
  .catch(() => null);

check(
  'DWG reader loads and reports a corrupt file clearly',
  // Must name the file and say something the user can act on, not just fail.
  typeof dwgMessage === 'string' &&
    /broken\.dwg/i.test(dwgMessage) &&
    /corrupt|newer format|could not/i.test(dwgMessage),
  dwgMessage ? dwgMessage.replace(/\s+/g, ' ').slice(0, 140) : 'no message shown'
);

// Whatever Emscripten logged, the page itself must still be alive and must
// not have thrown an unhandled error of our making.
const pageErrors = consoleErrors
  .slice(errorsBeforeDwg)
  .filter((e) => /Unhandled|not a function|undefined is not/i.test(e));
check(
  'corrupt DWG does not throw an unhandled error',
  pageErrors.length === 0,
  pageErrors.slice(0, 2).join(' | ')
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
