#!/usr/bin/env node
//
// Copies the nesting core out of the Electron app (../main) into
// public/vendor so Vite can serve it verbatim.
//
// These files are deliberately NOT converted to ES modules. They are classic
// scripts written against `this` / `window` at top level, and they are shared
// byte-for-byte with the desktop app. Rewriting them would fork the geometry
// code, which is the last thing anyone wants: it is the tuned, battle-tested
// part of Deepnest. Instead we copy them and apply the small set of documented
// shims below, so upstream fixes flow through by re-running this script.
//
// Run automatically via the `predev` / `prebuild` npm hooks.

import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const srcMain = join(repoRoot, 'main');
const webRoot = join(here, '..');
const outDir = join(webRoot, 'public', 'vendor');
const wasmDir = join(webRoot, 'public', 'wasm');

// Each entry: [source path relative to main/, shim function or null]
//
// The shims exist because these scripts were written for a context where
// `window` always exists. Inside a Web Worker it does not — `self` is the
// global. Nothing else about the geometry is touched.
const FILES = [
  // Must load before svgparser.js: it polyfills SVGPathElement.pathSegList,
  // which browsers removed and which svgparser.js relies on to walk paths.
  ['util/pathsegpolyfill.js', null],
  ['util/clipper.js', null],
  ['util/geometryutil.js', globalThisShim],
  ['util/placementworker.js', null],
  ['util/simplify.js', windowToGlobalThis],
  ['util/d3-polygon.js', null],
  ['util/matrix.js', null],
  ['util/hull.js', windowToGlobalThis],
  ['svgparser.js', globalThisShim],
];

// geometryutil.js and svgparser.js end with `}(this));` — the classic
// "pass the global in" pattern. Under a classic <script> or importScripts()
// top-level `this` is the global object, so this already works. But if the
// file is ever loaded in a strict/module context `this` is undefined and the
// library silently fails to register. Pinning it to globalThis makes the
// binding explicit and context-independent.
function globalThisShim(src) {
  return src.replace(/\}\s*\(\s*this\s*\)\s*\)?;?\s*$/, (m) =>
    m.replace(/\bthis\b/, 'globalThis')
  );
}

// `window.simplify = ...` / `window.ConvexHullGrahamScan = ...` break in a
// worker, where the global is `self`. globalThis covers both.
function windowToGlobalThis(src) {
  return src.replace(/\bwindow\.(?=[A-Za-z_$])/g, 'globalThis.');
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const banner = (rel) =>
  `/* Vendored from Deepnest main/${rel} by web/scripts/sync-core.mjs.\n` +
  `   Do not edit here - edit the original and re-run \`npm run sync-core\`. */\n`;

let copied = 0;
for (const [rel, shim] of FILES) {
  const from = join(srcMain, rel);
  let src;
  try {
    src = readFileSync(from, 'utf8');
  } catch (err) {
    console.error(`sync-core: missing ${from}`);
    process.exitCode = 1;
    continue;
  }
  const out = shim ? shim(src) : src;
  const name = rel.replace(/\//g, '-');
  writeFileSync(join(outDir, name), banner(rel) + out);
  copied++;
}

console.log(`sync-core: copied ${copied}/${FILES.length} core files to public/vendor`);

/*
 * Stage the OpenCascade WASM used for STEP import.
 *
 * occt-import-js is an Emscripten bundle: the .js loader fetches its .wasm
 * sibling at runtime. Bundlers routinely mangle that pairing, so serve both
 * verbatim from public/wasm and load the pair with a plain script tag instead.
 * They are only fetched when someone actually opens a STEP file.
 */
rmSync(wasmDir, { recursive: true, force: true });
mkdirSync(wasmDir, { recursive: true });

const occtDist = join(webRoot, 'node_modules', 'occt-import-js', 'dist');
for (const file of ['occt-import-js.js', 'occt-import-js.wasm']) {
  try {
    copyFileSync(join(occtDist, file), join(wasmDir, file));
  } catch (err) {
    console.error(
      `sync-core: could not stage ${file} - STEP import will be unavailable. ` +
        `Run \`npm install\` first.`
    );
    process.exitCode = 1;
  }
}

console.log('sync-core: staged OpenCascade WASM to public/wasm');
