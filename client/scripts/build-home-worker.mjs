/**
 * Builds a browser's own home — the hub in its worker — beside the app:
 * client/public/home/worker.js and the sqlite3.wasm it loads beside itself.
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

import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

import { build, context } from 'esbuild';

const require = createRequire(import.meta.url);
const CLIENT = resolve(import.meta.dirname, '..');
const OUT = join(CLIENT, 'public', 'home');
const watch = process.argv.includes('--watch');

mkdirSync(OUT, { recursive: true });
copyFileSync(require.resolve('@sqlite.org/sqlite-wasm/sqlite3.wasm'), join(OUT, 'sqlite3.wasm'));

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
