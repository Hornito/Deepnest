# Deepnest Web

Deepnest running entirely in the browser, with CAD import and a material
library. No Electron, no native addon, no server: open the page, drop in your
parts, pick your stock, nest.

The desktop app in the repository root is untouched — this lives alongside it
and shares its geometry core.

## What it does

- **Imports SVG, DXF, DWG, STEP and IGES.** All parsed locally in the browser.
- **Material library** with thickness, sheet size, part spacing and kerf.
  Presets for common stock; add your own. Saved in `localStorage`.
- **Nests** with the same genetic algorithm and no-fit-polygon geometry as the
  desktop app.
- **Exports** the nest as SVG or DXF, in millimetres, one layer per sheet.

## Running it

```bash
cd web
npm install
npm run dev      # http://localhost:5173
```

To produce a static build:

```bash
npm run build    # -> web/dist, deployable to any static host
npm run preview
```

Tests:

```bash
npm test                 # geometry unit tests (Node)
npm run build && npx vite preview --port 4173 &
node test/e2e.mjs        # full browser run in headless Chromium
```

## How it differs from the desktop app

Three things had to change to run in a browser. Each is worth knowing about.

### The native Minkowski addon is gone

The desktop app computes no-fit polygons in C++ (`minkowski.cc`), using a
Boost.Polygon convolution. That cannot load in a browser, so
`public/nesting/nfp.js` reproduces its output in JavaScript using ClipperLib
and GeometryUtil, which Deepnest already ships.

It relies on the outer NFP depending only on a part's outer boundary, and each
interior NFP depending only on one hole — so the outer case is a Clipper
Minkowski sum and each hole is GeometryUtil's orbiting inner-NFP. Upstream
SVGnest decomposes holes the same way.

`test/nfp.test.mjs` checks this against closed-form answers, and asserts the
property that actually matters: walking a part around the computed NFP, it
touches the other part but never overlaps it.

### Hidden Electron windows became Web Workers

`main.js` in the desktop app spawns hidden `BrowserWindow`s and talks to them
over `ipcRenderer`. Here the genetic algorithm runs on the main thread
(`src/core/nester.js`) and dispatches candidates to a pool of Web Workers
(`public/nesting/nest-worker.js`), one per core minus one.

The worker is a **classic** worker, not a module worker, so it can pull in the
nesting core with `importScripts()`. Those files are classic scripts that
register on the global object, and keeping them byte-identical to the desktop
app is worth more than module syntax.

### DXF is parsed locally instead of uploaded

The desktop app uploads DXF files to `convert.deepnest.io` and gets SVG back.
That is a hard dependency on a third-party server for a core feature, it breaks
when the server is down, and it sends your part geometry to someone else.

`src/import/dxf.js` parses DXF in the browser: lines, polylines (including
bulge arcs), arcs, circles, ellipses, splines and block references, with
`$INSUNITS` honoured so a drawing imports at its true size. Text, dimensions
and hatches are ignored — they are annotation, not cut geometry.

## Format notes

| Format | How it is read | Notes |
| --- | --- | --- |
| SVG | `svgparser.js`, unchanged | Parts must be closed paths |
| DXF | `dxf-parser`, locally | `$INSUNITS` honoured; warns if absent |
| DWG | LibreDWG (WASM) → DXF | Reuses the whole DXF path |
| STEP / IGES | OpenCascade (WASM) → flat profile | See below |

Both WASM readers are dynamically imported, so opening SVG or DXF files never
downloads them.

### STEP is projected, not unfolded

STEP is a 3D format and nesting is a 2D problem. The importer finds the plane
the part is flattest in and projects its silhouette onto it. Holes survive,
because the walls of a through hole project to zero area.

That is correct for plate parts — anything cut from flat stock, which is what
Deepnest is for. It is **not** a sheet-metal unfolder: a part with bends is
projected as it sits, so you get its footprint, not its flat pattern. The
importer measures how much of the part lies in one plane and warns when the
projection is not a true profile. Unfold bent parts in CAD first.

The measured thickness of the solid is reported too, and compared against the
selected material.

## Layout

```
web/
  index.html            app shell; loads the core as classic scripts
  scripts/sync-core.mjs copies ../main geometry into public/vendor
  public/
    vendor/             generated - the nesting core (gitignored)
    wasm/               generated - OpenCascade (gitignored)
    nesting/
      nfp.js            pure-JS replacement for the native addon
      nest-worker.js    classic Web Worker running NFP + placement
  src/
    core/               nester (GA + worker pool), parts, globals bridge
    import/             svg / dxf / dwg / step readers
    material/           material library and sheet generation
    export/             SVG and DXF writers
  test/                 unit tests + browser end-to-end run
```

`public/vendor` and `public/wasm` are generated by `scripts/sync-core.mjs`,
which runs automatically before `dev`, `build` and `test`. The geometry core is
copied rather than forked, so fixes to `main/util/*` reach the web build by
re-running it.

## Units

Everything physical is millimetres internally. Importers emit SVG with a
unit-suffixed `width`/`height` and a matching `viewBox`, which is how
`svgparser.js` derives an SVG's real-world scale — that pairing is load-bearing,
and a bare number makes it give up and import the part at the wrong size. The
mm/in toggle changes display only; the stored library never rescales.
