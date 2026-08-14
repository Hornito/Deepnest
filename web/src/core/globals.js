/*
 * Bridge from Deepnest's classic scripts to ES modules.
 *
 * clipper.js, geometryutil.js and svgparser.js are loaded with plain <script>
 * tags in index.html and register themselves on `window`. They cannot be
 * imported directly: each is wrapped in an IIFE that takes the global object
 * as `this`, which is `undefined` inside a module.
 *
 * Rather than scatter `window.GeometryUtil` through the app, everything goes
 * through this one module. That keeps the coupling to the vendored core in a
 * single file, and gives a clear error at startup if a script tag is missing
 * instead of a `Cannot read properties of undefined` deep inside a nest.
 */

function required(name) {
  const value = window[name];
  if (!value) {
    throw new Error(
      `Deepnest core script "${name}" is not loaded. ` +
        `Run \`npm run sync-core\` and check the <script> tags in index.html.`
    );
  }
  return value;
}

export const ClipperLib = required('ClipperLib');
export const GeometryUtil = required('GeometryUtil');
export const SvgParser = required('SvgParser');
