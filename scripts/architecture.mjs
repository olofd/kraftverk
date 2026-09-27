#!/usr/bin/env node
/**
 * The architecture, checked rather than hoped for. See docs/ARCHITECTURE.md §3 and §7.
 *
 * Two checks, each held by a baseline that may only shrink:
 *
 * - **The dependency rule.** The core never imports a device type, a service or
 *   a protocol; a device type never reaches into the app; a protocol knows no
 *   product. A new import that breaks it fails the build.
 * - **The leak count.** Product-specific identifiers — `core.station`, `p280`,
 *   `StationStatus` and the rest — outside the P280's own package, counted per
 *   file. A count that rises fails the build.
 *
 * Today's exceptions are listed in scripts/architecture-baseline.json, file by
 * file. A file that gets better fails too, until `--update` records it: the
 * baseline then always says exactly where the leaks are, and the number can
 * only go one way.
 *
 *   node scripts/architecture.mjs            check
 *   node scripts/architecture.mjs --update   record improvements (refuses regressions)
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = resolve(ROOT, 'scripts/architecture-baseline.json');
const SELF = ['scripts/architecture.mjs', 'scripts/architecture-baseline.json'];

/** The identifiers that mean one product, and so belong in its package only. */
const LEAK = /core\.station|p280|P280|StationStatus|StationSettings|power-station|gridRelay/g;
/** Where they are allowed. */
const LEAK_HOME = 'packages/devices/aferiy-p280/';

const SOURCE = /\.(ts|tsx|mts|js|mjs|jsx)$/;

// --- where a file belongs ----------------------------------------------------

/** The core: knows no device type, service or protocol. */
const CORE = [
  'server/src/',
  'client/src/',
  'client/app/',
  'packages/api-client/',
  'packages/ui/',
  'packages/plugin-sdk/',
  'packages/device-sdk/',
];
/** The one file per side allowed to import every device type. */
const GENERATED = ['server/src/generated/', 'client/src/generated/'];

/** `packages/devices/x/…` → `packages/devices/x/`. */
const packageRoot = (file, parents) => {
  for (const parent of parents) {
    if (!file.startsWith(parent)) continue;
    const name = file.slice(parent.length).split('/')[0];
    if (name) return `${parent}${name}/`;
  }
  return null;
};

const DEVICE_PARENTS = ['packages/devices/', 'packages/services/', 'packages/plugins/'];
const PROTOCOL_PARENTS = ['packages/protocols/'];

function areaOf(file) {
  if (GENERATED.some((prefix) => file.startsWith(prefix))) return { kind: 'generated' };
  if (CORE.some((prefix) => file.startsWith(prefix))) return { kind: 'core' };
  const device = packageRoot(file, DEVICE_PARENTS);
  if (device) return { kind: 'device', root: device };
  if (file.startsWith('packages/protocol/')) return { kind: 'protocol', root: 'packages/protocol/' };
  const protocol = packageRoot(file, PROTOCOL_PARENTS);
  if (protocol) return { kind: 'protocol', root: protocol };
  return { kind: 'other' };
}

// --- the dependency rule ---------------------------------------------------

/** Workspace packages that are device types, services or protocols. */
const PRODUCT_PACKAGE = /^@kraftverk\/(device-(?!sdk)|service-|protocol|plugin-(?!sdk))/;
const PRODUCT_PATH = /^packages\/(devices|services|plugins|protocols?)\//;
/** What server-safe device code may not pull in: it runs inside the server. */
const UI_ONLY = /^(react|react-native|tamagui|@tamagui\/|expo|@expo\/|@kraftverk\/(ui|api-client))(\/|$)/;

function importsOf(source) {
  const found = new Set();
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /^\s*import\s+['"]([^'"]+)['"]/gm,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) for (const match of source.matchAll(pattern)) found.add(match[1]);
  return [...found];
}

/** Why an import breaks the rule, or null. */
function violation(file, area, specifier) {
  const relative = specifier.startsWith('.');
  const target = relative ? posix.normalize(posix.join(posix.dirname(file), specifier)) : null;

  switch (area.kind) {
    case 'core':
      if (PRODUCT_PACKAGE.test(specifier)) return 'the core imports a product package';
      if (target && PRODUCT_PATH.test(target)) return 'the core reaches into a product package';
      return null;

    case 'device': {
      if (target && !target.startsWith(area.root)) return 'a device type reaches outside its package';
      if (/^@kraftverk\/(server|client)(\/|$)/.test(specifier)) return 'a device type imports the app';
      const serverSafe = file.startsWith(`${area.root}src/`);
      if (serverSafe && UI_ONLY.test(specifier)) return 'server-side device code imports UI';
      return null;
    }

    case 'protocol':
      if (target && !target.startsWith(area.root)) return 'a protocol reaches outside its package';
      if (specifier.startsWith('@kraftverk/') && !/^@kraftverk\/protocol/.test(specifier)) {
        return 'a protocol imports something other than a protocol';
      }
      return null;

    default:
      return null;
  }
}

// --- measuring -------------------------------------------------------------

function sourceFiles() {
  const listed = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return listed
    .split('\n')
    .map((line) => line.trim())
    .filter((file) => file && SOURCE.test(file) && !file.includes('node_modules/') && !SELF.includes(file))
    .filter((file) => /^(server|client|packages|scripts)\//.test(file))
    .sort();
}

function measure() {
  const imports = {};
  const leaks = {};

  for (const file of sourceFiles()) {
    let source;
    try {
      source = readFileSync(resolve(ROOT, file), 'utf8');
    } catch {
      continue; // listed but deleted in the working tree
    }

    const area = areaOf(file);
    const broken = importsOf(source)
      .filter((specifier) => violation(file, area, specifier))
      .sort();
    if (broken.length) imports[file] = broken;

    if (!file.startsWith(LEAK_HOME)) {
      const count = source.match(LEAK)?.length ?? 0;
      if (count) leaks[file] = count;
    }
  }

  return { imports, leaks };
}

// --- comparing with the baseline ------------------------------------------

function compare(baseline, current) {
  const worse = [];
  const better = [];

  for (const [file, specifiers] of Object.entries(current.imports)) {
    const allowed = new Set(baseline.imports[file] ?? []);
    for (const specifier of specifiers) {
      if (!allowed.has(specifier)) {
        const area = areaOf(file);
        worse.push(`${file}: imports ${specifier} (${violation(file, area, specifier)})`);
      }
    }
  }
  for (const [file, specifiers] of Object.entries(baseline.imports)) {
    const now = new Set(current.imports[file] ?? []);
    for (const specifier of specifiers) if (!now.has(specifier)) better.push(`${file}: no longer imports ${specifier}`);
  }

  for (const [file, count] of Object.entries(current.leaks)) {
    const allowed = baseline.leaks[file] ?? 0;
    if (count > allowed) worse.push(`${file}: ${count} product identifiers, ${allowed} allowed`);
  }
  for (const [file, allowed] of Object.entries(baseline.leaks)) {
    const count = current.leaks[file] ?? 0;
    if (count < allowed) better.push(`${file}: ${count} product identifiers, down from ${allowed}`);
  }

  return { worse, better };
}

const total = (leaks) => Object.values(leaks).reduce((sum, count) => sum + count, 0);
const importCount = (imports) => Object.values(imports).reduce((sum, list) => sum + list.length, 0);

function load() {
  try {
    const raw = JSON.parse(readFileSync(BASELINE, 'utf8'));
    return { imports: raw.imports ?? {}, leaks: raw.leaks ?? {} };
  } catch {
    return { imports: {}, leaks: {} };
  }
}

function save(current) {
  const body = {
    $comment:
      'Where the architecture is still broken, file by file. May only shrink. ' +
      'See docs/ARCHITECTURE.md section 7; update with npm run check:architecture -- --update.',
    imports: current.imports,
    leaks: current.leaks,
  };
  writeFileSync(BASELINE, `${JSON.stringify(body, null, 2)}\n`);
}

const update = process.argv.includes('--update');
const init = process.argv.includes('--init');
const baseline = load();
const current = measure();
const { worse, better } = compare(baseline, current);

const summary =
  `${importCount(current.imports)} boundary exceptions, ` +
  `${total(current.leaks)} product identifiers outside ${LEAK_HOME} in ${Object.keys(current.leaks).length} files`;

if (worse.length && !init) {
  console.error('The architecture got worse:\n');
  for (const line of worse) console.error(`  ✗ ${line}`);
  console.error(
    '\nMove product knowledge into its package instead (docs/ARCHITECTURE.md §3).' +
      (update ? ' --update records improvements only.' : '')
  );
  process.exit(1);
}

if (update || init) {
  save(current);
  console.log(`Baseline recorded: ${summary}.`);
  process.exit(0);
}

if (better.length) {
  console.error('The architecture got better — record it, so it cannot slip back:\n');
  for (const line of better) console.error(`  ✓ ${line}`);
  console.error('\nRun: npm run check:architecture -- --update');
  process.exit(1);
}

console.log(`Architecture holds: ${summary}.`);
