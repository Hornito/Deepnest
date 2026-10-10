/*
 * STEP import tests, run against real STEP files.
 *
 * The projection is the part of STEP import that can silently produce a
 * plausible-but-wrong part, so it is checked against solids whose true
 * dimensions are known: a 10mm cube must come out as a 10x10mm square, and a
 * cube declared in metres or inches must come out at the same physical size as
 * one declared in millimetres.
 *
 * Only the geometry is exercised here. Loading the WASM through a <script> tag
 * needs a DOM and is covered by the browser end-to-end run instead.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const fixtures = join(
  here,
  '..',
  'node_modules',
  'occt-import-js',
  'test',
  'testfiles'
);

// ClipperLib is a classic script that expects a browser-ish global. Load it
// into a vm and publish it, since step.js reads it off globalThis at call time
// exactly so this is possible.
function installClipper() {
  const sandbox = { navigator: { userAgent: 'node', appName: 'Netscape' }, console };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  const context = createContext(sandbox);
  runInContext(
    readFileSync(join(here, '..', 'public', 'vendor', 'util-clipper.js'), 'utf8'),
    context
  );
  globalThis.ClipperLib = sandbox.ClipperLib;
}

installClipper();

const { profileFromMeshes } = await import('../src/import/step.js');

const occt = await require('occt-import-js')();

function readStep(relPath) {
  const bytes = new Uint8Array(readFileSync(join(fixtures, relPath)));
  const result = occt.ReadStepFile(bytes, {
    linearUnit: 'millimeter',
    linearDeflectionType: 'absolute_value',
    linearDeflection: 0.05,
    angularDeflection: 0.5,
  });
  assert.ok(result.success, `OpenCascade failed to read ${relPath}`);
  return result.meshes;
}

const dims = (svg) => ({
  width: Number(svg.match(/width="([\d.]+)mm"/)[1]),
  height: Number(svg.match(/height="([\d.]+)mm"/)[1]),
});

const close = (a, b, tol = 0.05) =>
  assert.ok(Math.abs(a - b) < tol, `expected ${a} to be within ${tol} of ${b}`);

test('projects a 10mm cube to a 10x10mm square profile', () => {
  const result = profileFromMeshes(readStep('cube-10x10mm/Cube 10x10.stp'));
  const { width, height } = dims(result.svg);

  close(width, 10);
  close(height, 10);
});

test('reports thickness along the projection normal', () => {
  const result = profileFromMeshes(readStep('cube-10x10mm/Cube 10x10.stp'));

  // A cube is 10mm through in every direction, so whichever plane is chosen
  // the thickness is 10mm. This is what seeds the material thickness field.
  close(result.thickness, 10);
});

test('a cube reads as flat: all its surface area lies in axis planes', () => {
  const result = profileFromMeshes(readStep('cube-10x10mm/Cube 10x10.stp'));

  // Every face of a cube is perpendicular to some axis, so two of the six
  // faces lie in the chosen plane: a third of the total area.
  assert.ok(
    result.flatness > 0.3,
    `expected a substantial in-plane fraction, got ${result.flatness}`
  );
});

test('unit declarations are honoured so parts import at true size', () => {
  // The same cube declared in millimetres, metres and inches. OpenCascade is
  // asked for millimetres, so all three must land on the same physical size -
  // getting this wrong scales a part by 25.4x or 1000x.
  const mm = dims(profileFromMeshes(readStep('cube-units/cube-mm.step')).svg);
  const m = dims(profileFromMeshes(readStep('cube-units/cube-m.step')).svg);
  const inch = dims(profileFromMeshes(readStep('cube-units/cube-in.step')).svg);

  close(m.width, mm.width, 0.01);
  close(m.height, mm.height, 0.01);
  close(inch.width, mm.width, 0.01);
  close(inch.height, mm.height, 0.01);
});

test('a rounded cube still projects to a sane profile', () => {
  // Filleted edges mean far fewer triangles lie exactly in plane, which is the
  // case that would break a naive "pick the biggest face" approach.
  const result = profileFromMeshes(readStep('rounded-cube/rounded-cube.step'));
  const { width, height } = dims(result.svg);

  assert.ok(width > 0 && height > 0, 'profile must have real extent');
  assert.ok(
    Math.abs(width - height) < width * 0.1,
    `a rounded cube should project near-square, got ${width}x${height}`
  );
});

test('the SVG uses evenodd so holes are read as holes', () => {
  const result = profileFromMeshes(readStep('cube-10x10mm/Cube 10x10.stp'));
  assert.match(result.svg, /fill-rule="evenodd"/);
  assert.match(result.svg, /^<svg /);
});

test('profiles are emitted in millimetres, unit-suffixed', () => {
  // SvgParser reads an SVG's real-world scale from a unit-suffixed width plus
  // a matching viewBox. Without the suffix it gives up ("no scale") and the
  // part imports at raw user units - the wrong physical size.
  const result = profileFromMeshes(readStep('cube-10x10mm/Cube 10x10.stp'));

  assert.match(result.svg, /width="[\d.]+mm"/);
  assert.match(result.svg, /height="[\d.]+mm"/);
  assert.match(result.svg, /viewBox="0 0 [\d.]+ [\d.]+"/);
});

test('empty mesh input is rejected with a clear message', () => {
  assert.throws(() => profileFromMeshes([]), /no solid geometry/i);
  assert.throws(() => profileFromMeshes(null), /no solid geometry/i);
});
