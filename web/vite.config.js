import { defineConfig } from 'vite';

// Deepnest for the browser.
//
// Two things drive this config:
//  1. occt-import-js ships a ~7.6MB .wasm that must be served as a real file,
//     not inlined. It lives in public/wasm and is fetched at runtime, so STEP
//     support costs nothing until someone actually opens a STEP file.
//  2. The nesting core (clipper/geometryutil/placementworker) is a set of
//     classic scripts that assign to `this` at top level. They cannot be ESM
//     imports, so they are served verbatim from public/vendor and pulled in
//     with <script> on the main thread and importScripts() in the worker.
export default defineConfig({
  base: './',
  worker: {
    format: 'es',
  },
  build: {
    target: 'es2020',
    outDir: 'dist',
    assetsInlineLimit: 4096,
    rollupOptions: {
      output: {
        manualChunks: {
          // Keep the CAD readers out of the initial bundle.
          dxf: ['dxf-parser'],
          dwg: ['@mlightcad/libredwg-web'],
        },
      },
    },
  },
  optimizeDeps: {
    exclude: ['occt-import-js'],
  },
  server: {
    port: 5173,
    fs: { allow: ['..'] },
  },
});
