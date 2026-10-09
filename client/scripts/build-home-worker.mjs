/**
 * Builds a browser's own home — the hub in its worker — beside the app:
 * client/public/home/worker.js, and the sqlite3.wasm and quickjs.wasm (the
 * engine its scripts run in, docs/PLAN-SCRIPTS.md) it loads beside itself.
 * docs/PLAN-SHARED-CORE.md, "SQLite in the app".
 *
 * Bundled here rather than by Metro: Metro's workers are alpha, and SQLite's
 * WebAssembly build finds its .wasm beside its own script, which a bundle of
 * its own keeps true. Nothing of the page is in it — no React, no screens,
 * no transport (the page runs those) — and nothing of it is in the page.
 *
 *   node scripts/build-home-worker.mjs            build it, minified
 *   node scripts/build-home-worker.mjs --watch    and again on every change
 */

import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

import { build, context } from 'esbuild';

const require = createRequire(import.meta.url);
const CLIENT = resolve(import.meta.dirname, '..');
const OUT = join(CLIENT, 'public', 'home');
const watch = process.argv.includes('--watch');

mkdirSync(OUT, { recursive: true });
copyFileSync(require.resolve('@sqlite.org/sqlite-wasm/sqlite3.wasm'), join(OUT, 'sqlite3.wasm'));
copyFileSync(require.resolve('@jitl/quickjs-ng-wasmfile-release-sync/wasm'), join(OUT, 'quickjs.wasm'));

/*
  The map's renderer (MapLibre GL, docs/PLAN-MAPS.md), beside the app too:
  loaded by the page only when a map is shown — a megabyte nobody needs
  until then — from this app's own origin, never bundled (it finds its
  worker by `import.meta.url`, which Metro does not give it). A module of
  ours loads it, tells it where its worker is, and hands it to the page.
*/
const MAP = join(CLIENT, 'public', 'map');
mkdirSync(MAP, { recursive: true });
const maplibre = join(dirname(require.resolve('maplibre-gl/package.json')), 'dist');
for (const file of ['maplibre-gl.mjs', 'maplibre-gl-worker.mjs', 'maplibre-gl.css']) copyFileSync(join(maplibre, file), join(MAP, file));
writeFileSync(
  join(MAP, 'load.mjs'),
  [
    "import * as maplibregl from './maplibre-gl.mjs';",
    "maplibregl.setWorkerUrl(new URL('./maplibre-gl-worker.mjs', import.meta.url).href);",
    'window.__kraftverkMapLibre = maplibregl;',
    "window.dispatchEvent(new Event('kraftverk-maplibre'));",
    '',
  ].join('\n')
);

const options = {
  entryPoints: [join(CLIENT, 'src/platform/home/worker.ts')],
  outfile: join(OUT, 'worker.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: !watch,
  sourcemap: true,
  logLevel: 'warning',
  legalComments: 'linked',
};

if (watch) {
  const watching = await context(options);
  await watching.watch();
  console.log('[home worker] built; rebuilding on change');
} else {
  await build(options);
  console.log(`[home worker] built: ${OUT}`);
}
