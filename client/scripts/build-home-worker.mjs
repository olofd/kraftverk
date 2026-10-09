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

import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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

/*
  The script editor's language service (docs/PLAN-SCRIPTS.md §11.2), in a
  worker of its own: client/public/script/language.js — TypeScript 6, some
  megabytes, loaded only when a script is edited — and lib.json beside it:
  the language's own declarations (ES2022 and what it references, no DOM),
  read from the TypeScript the language package depends on. TypeScript
  names Node's modules where it runs under Node, never in a browser: left
  out of the bundle.
*/
const SCRIPT = join(CLIENT, 'public', 'script');
mkdirSync(SCRIPT, { recursive: true });
const languagePackage = createRequire(require.resolve('@kraftverk/script-language/package.json'));
const lib = dirname(languagePackage.resolve('typescript/lib/lib.es2022.d.ts'));
writeFileSync(
  join(SCRIPT, 'lib.json'),
  JSON.stringify(Object.fromEntries(readdirSync(lib).filter((name) => /^lib\.(es|decorators).*\.d\.ts$/.test(name)).map((name) => [name, readFileSync(join(lib, name), 'utf8')])))
);
const language = {
  ...options,
  entryPoints: [join(CLIENT, 'src/platform/script/worker.ts')],
  outfile: join(SCRIPT, 'language.js'),
  external: ['fs', 'path', 'os', 'crypto', 'buffer', 'inspector', 'perf_hooks', 'module', 'url', 'util', 'source-map-support', 'node:*'],
};

if (watch) {
  const watching = await context(options);
  await watching.watch();
  await (await context(language)).watch();
  console.log('[home worker] built; rebuilding on change');
} else {
  await build(options);
  await build(language);
  console.log(`[home worker] built: ${OUT}, and the script editor's language service: ${SCRIPT}`);
}
