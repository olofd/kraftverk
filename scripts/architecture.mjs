#!/usr/bin/env node
/**
 * The architecture, checked rather than hoped for. See docs/ARCHITECTURE.md §3 and §7.
 *
 * Two checks, each held by a baseline that may only shrink:
 *
 * - **The dependency rule.** The core never imports a device type, a service, a
 *   protocol or a transport; a device type never reaches into the app or a
 *   transport; a protocol knows no product; protocols and device code import no
 *   platform built-in. A new import that breaks it fails the build.
 * - **The leak count.** Words that mean one product — every device, service
 *   and protocol package's folder name and brand, and the words it lists in
 *   its package.json (`kraftverk.words`) — counted per file wherever that
 *   package is not: in the core, and in a package that does not depend on it.
 *   A count that rises fails the build. The words are derived from what is
 *   installed, so the next package is held to it the day it arrives.
 *
 * Today's exceptions are listed in scripts/architecture-baseline.json, file by
 * file. A file that gets better fails too, until `--update` records it: the
 * baseline then always says exactly where the leaks are, and the number can
 * only go one way.
 *
 *   node scripts/architecture.mjs               check
 *   node scripts/architecture.mjs --update      record improvements (refuses regressions)
 *   node scripts/architecture.mjs --rebaseline  after moving files: accepts leaks in new
 *                                               places, but only if neither total rose
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = resolve(ROOT, 'scripts/architecture-baseline.json');
const SELF = ['scripts/architecture.mjs', 'scripts/architecture-baseline.json'];

const SOURCE = /\.(ts|tsx|mts|js|mjs|jsx)$/;
/** Test files: held to the dependency rule, but not counted for product identifiers. */
const TEST = /\.test\.(ts|tsx)$|(^|\/)test\//;

// --- where a file belongs ----------------------------------------------------

/** The core: knows no device type, service or protocol. */
const CORE = ['server/src/', 'client/src/', 'client/app/'];
/** A core package's folder: the server, the app and these know no product. */
const isCorePackage = (file) => /^packages\/[^/]+\//.test(file) && corePackageOf(file) !== null;
/**
 * The core packages, and which of them each may import, by name: the layers
 * of docs/PLAN-SHARED-CORE.md, lowest first. An import the table does not
 * list fails — up the layers, or across them where it says not. A package
 * planned and not yet made is here already, so it is held from its first
 * file.
 */
const MAY_IMPORT = {
  'device-sdk': [],
  automation: ['device-sdk'],
  gateway: ['device-sdk'],
  'home-file': ['device-sdk', 'automation'],
  'api-contract': ['device-sdk', 'automation', 'gateway', 'home-file'],
  holder: ['device-sdk', 'automation', 'gateway', 'api-contract'],
  'automation-engine': ['device-sdk', 'automation', 'gateway', 'api-contract', 'holder'],
  store: ['device-sdk', 'automation', 'gateway', 'api-contract', 'holder', 'automation-engine'],
  hub: ['device-sdk', 'automation', 'gateway', 'home-file', 'api-contract', 'holder', 'automation-engine', 'store'],
  // A home and a transport over a message port: served on one side, the same interface on the other.
  'message-port': ['device-sdk', 'automation', 'gateway', 'home-file', 'api-contract'],
  // The edges: the API over HTTP, and the React kit.
  'api-client': ['device-sdk', 'automation', 'gateway', 'home-file', 'api-contract'],
  ui: ['device-sdk'],
};
/** The edges among the core packages: the rest is shared. */
const EDGE_PACKAGES = new Set(['api-client', 'ui']);
const SHARED_PACKAGES = Object.keys(MAY_IMPORT).filter((name) => !EDGE_PACKAGES.has(name));
/** What a device type may import of the core: the contract, and the language to declare recipes in. */
const DEVICE_MAY_IMPORT = new Set(['device-sdk', 'automation']);

/**
 * The core both holders run: the server and the app. Pure, like a protocol —
 * no platform built-in — or the app could not run it (docs/PLAN-SHARED-CORE.md;
 * tsconfig.shared.json checks the same against the globals every place has).
 */
const SHARED_CORE = new RegExp(`^packages/(${SHARED_PACKAGES.join('|')})/src/`);
/** `packages/hub/src/x.ts` → `hub`; null outside a core package. */
const corePackageOf = (file) => {
  const match = /^packages\/([^/]+)\//.exec(file);
  return match && match[1] in MAY_IMPORT ? match[1] : null;
};
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

const DEVICE_PARENTS = ['packages/devices/', 'packages/services/'];
const PROTOCOL_PARENTS = ['packages/protocols/'];
const TRANSPORT_PARENTS = ['packages/transports/'];

function areaOf(file) {
  if (GENERATED.some((prefix) => file.startsWith(prefix))) return { kind: 'generated' };
  if (CORE.some((prefix) => file.startsWith(prefix)) || isCorePackage(file)) return { kind: 'core' };
  const device = packageRoot(file, DEVICE_PARENTS);
  if (device) return { kind: 'device', root: device };
  const protocol = packageRoot(file, PROTOCOL_PARENTS);
  if (protocol) return { kind: 'protocol', root: protocol };
  const transport = packageRoot(file, TRANSPORT_PARENTS);
  if (transport) return { kind: 'transport', root: transport };
  return { kind: 'other' };
}

// --- the words that mean one product --------------------------------------

/**
 * Transports are not here: Bluetooth and MQTT are technologies the core may
 * name. A device, a service or a protocol is a product the core must not.
 */
const WORD_PARENTS = [...DEVICE_PARENTS, ...PROTOCOL_PARENTS];

const escape = (word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Case-insensitive; a hyphen may be written or left out (`open-meteo`, `OpenMeteo`). */
const wordPattern = (word) => escape(word).split('-').join('-?');

/**
 * Every product package: where it is, which packages it may name (its own
 * dependencies), and the words that mean it.
 */
function productPackages() {
  const found = [];
  for (const parent of WORD_PARENTS) {
    const listed = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', `${parent}*/package.json`], { cwd: ROOT, encoding: 'utf8' });
    for (const manifest of listed.split('\n').map((line) => line.trim()).filter(Boolean)) {
      if (manifest.includes('node_modules/')) continue;
      const root = manifest.slice(0, -'package.json'.length);
      const json = JSON.parse(readFileSync(resolve(ROOT, manifest), 'utf8'));
      const folder = root.slice(parent.length, -1);
      const words = new Set([folder, ...(json.kraftverk?.words ?? [])]);
      // Its brand, from what it declares about itself.
      const listedSources = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', `${root}src`], { cwd: ROOT, encoding: 'utf8' });
      for (const file of listedSources.split('\n').map((line) => line.trim()).filter((line) => SOURCE.test(line) && !TEST.test(line))) {
        let source;
        try {
          source = readFileSync(resolve(ROOT, file), 'utf8');
        } catch {
          continue;
        }
        for (const match of source.matchAll(/\bbrand:\s*'([^']+)'/g)) words.add(match[1]);
      }
      found.push({ root, name: json.name, dependencies: new Set(Object.keys({ ...json.dependencies, ...json.peerDependencies })), words: [...words] });
    }
  }
  return found;
}

const PRODUCTS = productPackages();

// A word a package shares with a package it is built on is that one's, not its own: a Zigbee plug on
// the Tuya socket says Tuya as the socket does, and the ATORCH — on the same socket — may too.
for (const product of PRODUCTS) {
  const flat = (word) => word.toLowerCase().split('-').join('');
  const inherited = new Set(PRODUCTS.filter((other) => product.dependencies.has(other.name)).flatMap((other) => other.words.map(flat)));
  product.words = product.words.filter((word) => !inherited.has(flat(word)));
}

/** The words a file may not use: those of every product package it neither is nor depends on. */
function forbiddenFor(file, area) {
  if (area.kind === 'core') return PRODUCTS;
  if (area.kind !== 'device' && area.kind !== 'protocol') return [];
  const own = PRODUCTS.find((product) => product.root === area.root);
  return PRODUCTS.filter((product) => product.root !== area.root && !own?.dependencies.has(product.name));
}

const plain = (word) => word.toLowerCase().split('-').join('');

const leakPatterns = new Map();
function leakPattern(products, area) {
  // A word that contains one of its own package's words, or is contained by one, is its own too:
  // the Tuya protocol may say Tuya, and name its generic Tuya plug.
  const own = PRODUCTS.find((product) => product.root === area.root)?.words.map(plain) ?? [];
  const key = `${area.root ?? ''}:${products.map((product) => product.root).join('|')}`;
  if (!leakPatterns.has(key)) {
    const words = [...new Set(products.flatMap((product) => product.words))]
      .filter((word) => !own.some((mine) => mine.includes(plain(word)) || plain(word).includes(mine)))
      .sort((a, b) => b.length - a.length);
    leakPatterns.set(key, words.length ? new RegExp(words.map(wordPattern).join('|'), 'gi') : null);
  }
  return leakPatterns.get(key);
}

// --- the dependency rule ---------------------------------------------------

/** Workspace packages that are device types, services, protocols or transports. */
const PRODUCT_PACKAGE = /^@kraftverk\/(device-(?!sdk)|service-|protocol-|transport-)/;
const PRODUCT_PATH = /^packages\/(devices|services|protocols|transports)\//;
/** What server-safe device code may not pull in: it runs inside the server. */
const UI_ONLY = /^(react|react-native|tamagui|@tamagui\/|expo|@expo\/|@kraftverk\/(ui|api-client))(\/|$)/;
/** Platform built-ins: I/O. Pure code runs in the app as well as on the server. */
const BUILT_IN = /^(node:|bun:|bun$)/;

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
  const shipped = !TEST.test(file);

  switch (area.kind) {
    case 'core': {
      if (PRODUCT_PACKAGE.test(specifier)) return 'the core imports a device type, service, protocol or transport';
      if (target && PRODUCT_PATH.test(target)) return 'the core reaches into a product package';
      if (SHARED_CORE.test(file) && shipped && BUILT_IN.test(specifier)) return 'shared core imports a platform built-in: the app runs it too';
      // The layers: a core package imports only what the table lets it, by name, never by a path.
      const own = corePackageOf(file);
      if (own) {
        const named = /^@kraftverk\/([^/]+)/.exec(specifier)?.[1];
        if (named && named !== own && named in MAY_IMPORT && !MAY_IMPORT[own].includes(named)) return `${own} may not import ${named}: it is not below it (docs/PLAN-SHARED-CORE.md)`;
        if (target && !target.startsWith(`packages/${own}/`) && target.startsWith('packages/')) return `${own} reaches into another package by a path`;
        if (shipped && (/^@kraftverk\/(server|client)(\/|$)/.test(specifier) || (target && /^(server|client)\//.test(target)))) return 'a package imports the server or the app';
      }
      return null;
    }

    case 'device': {
      if (target && !target.startsWith(area.root)) return 'a device type reaches outside its package';
      if (/^@kraftverk\/(server|client)(\/|$)/.test(specifier)) return 'a device type imports the app';
      if (/^@kraftverk\/transport-/.test(specifier)) return 'a device type imports a transport: it is handed a connection';
      const serverSafe = file.startsWith(`${area.root}src/`);
      // Of the core, the contract and the language; its screens add the kit and the API.
      const core = /^@kraftverk\/([^/]+)/.exec(specifier)?.[1];
      if (core && core in MAY_IMPORT && !DEVICE_MAY_IMPORT.has(core) && (serverSafe || !EDGE_PACKAGES.has(core))) return `a device type imports ${core}: of the core, only the SDK and the language`;
      if (serverSafe && UI_ONLY.test(specifier)) return 'server-side device code imports UI';
      // Its own screens included: what the server loads never depends on a package's page.
      if (serverSafe && target && target.startsWith(`${area.root}ui/`)) return "server-side device code imports its package's screens";
      if (serverSafe && shipped && BUILT_IN.test(specifier)) return 'device code imports a platform built-in: it runs in the app too';
      // The SDK, protocols, and a family's base type by name (the ATORCH S1W is a Tuya socket).
      return null;
    }

    case 'protocol':
      if (target && !target.startsWith(area.root)) return 'a protocol reaches outside its package';
      if (specifier.startsWith('@kraftverk/') && !/^@kraftverk\/(device-sdk|protocol-)/.test(specifier)) {
        return 'a protocol imports something other than the SDK or a protocol';
      }
      if (file.startsWith(`${area.root}src/`) && shipped && BUILT_IN.test(specifier)) return 'a protocol imports a platform built-in: it must stay pure';
      return null;

    case 'transport': {
      if (target && !target.startsWith(area.root)) return 'a transport reaches outside its package';
      if (specifier.startsWith('@kraftverk/') && !/^@kraftverk\/device-sdk(\/|$)/.test(specifier)) {
        return 'a transport imports something from kraftverk other than the SDK';
      }
      // The app bundles a transport's web and native entries: they must never pull in its system one.
      const appEntry = /\/src\/(web|native)(\.tsx?|\/)/.test(file);
      if (appEntry && target && /\/src\/system(\.tsx?|\/|$)/.test(target)) return "a transport's app entry reaches its system entry";
      return null;
    }

    default:
      return null;
  }
}

// --- where code lives ------------------------------------------------------------

/**
 * What `server/src` may hold: only what an always-running machine on the
 * network is — the HTTP API, accounts, the admin's reset, the platform (its
 * database file, its disk, the packages found on it) and the process. Logic
 * anywhere else in it is a package's: an exception the baseline lists until
 * it has moved (docs/PLAN-SHARED-CORE.md).
 */
const SERVER_PLACES = /^server\/src\/((routes|auth|admin|platform)\/|(app|index|log|config)\.ts$)/;
/** What makes a file of the app a screen, or React's binding to one. */
const SCREEN = /^(react|tamagui|@tamagui\/|@kraftverk\/ui)(\/|$)/;

/** Why a file is in the wrong place, or null. */
function misplaced(file, source) {
  if (TEST.test(file)) return null;
  if (file.startsWith('server/src/')) return SERVER_PLACES.test(file) ? null : "logic that is not the server's: it belongs in a package";
  // The app's .tsx are screens; a .ts with no screen in it, outside the platform's own, is logic.
  if (file.startsWith('client/src/') && file.endsWith('.ts') && !/^client\/src\/(platform|generated)\//.test(file)) {
    return importsOf(source).some((specifier) => SCREEN.test(specifier)) ? null : 'no screen in it: it belongs in a package';
  }
  return null;
}

/** A folder under `packages/` that is neither a product's nor in the layers: it would be held to nothing. */
function unplacedPackages() {
  const listed = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'packages/*/package.json'], { cwd: ROOT, encoding: 'utf8' });
  return listed
    .split('\n')
    .map((line) => line.trim().split('/'))
    // Git's * crosses folders: only `packages/x/package.json` is a core package's.
    .filter((parts) => parts.length === 3)
    .map((parts) => parts[1])
    .filter((name) => !(name in MAY_IMPORT))
    .map((name) => `packages/${name}: a core package with no place in the layers — add it to MAY_IMPORT in scripts/architecture.mjs`);
}

// --- every package says what it is ---------------------------------------------

/**
 * What every package's README says, under these headings, so any agent
 * picking one up finds the same four things in the same place: what it is,
 * what it does and does not, where it fits in the layers, and why it is a
 * package of its own (the owner, 2026-10-02).
 */
const README_SECTIONS = ['## What it is', '## What it does — and does not', '## Where it fits', '## Why a package of its own'];

function undocumentedPackages() {
  const manifests = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'packages/*/package.json', 'packages/*/*/package.json'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.includes('node_modules/'));
  const found = [];
  for (const manifest of manifests) {
    const root = manifest.slice(0, -'package.json'.length);
    let readme;
    try {
      readme = readFileSync(resolve(ROOT, root, 'README.md'), 'utf8').replace(/\r\n/g, '\n');
    } catch {
      found.push(`${root}: no README.md — say what it is, what it does and does not, where it fits, and why it is a package of its own`);
      continue;
    }
    const lines = new Set(readme.split('\n').map((line) => line.trim()));
    const missing = README_SECTIONS.filter((heading) => !lines.has(heading));
    if (missing.length) found.push(`${root}README.md: missing ${missing.map((heading) => `"${heading}"`).join(', ')}`);
  }
  return found;
}

// --- shared code bundles for a browser ---------------------------------------------

/** Node's own modules, bare (`fs`) and prefixed (`node:fs`), and Bun's. */
const PLATFORM_MODULE = new RegExp(
  // `require` with no word boundary: a bundled CommonJS dependency's require("fs") becomes __require("fs").
  `(?:\\bfrom\\s*|\\bimport\\s*\\(\\s*|require\\s*\\(\\s*)["'](?:node:[^"']+|bun(?::[^"']+)?|${builtinModules.filter((name) => !name.startsWith('_')).map((name) => name.replace(/[/]/g, '\\/')).join('|')})["']`
);

/**
 * Each shared package — the core's, and every protocol, device type and
 * service — bundled for a browser with every dependency, and read for a
 * platform module: a dependency that needs Node fails here, which no
 * typecheck sees. Bun swaps Node's modules for stand-ins in a browser build,
 * and marks them: a polyfill is a section `// node:crypto`, an emptied one
 * `= (() => ({}))`. Either, or an import of one left over, is a dependency
 * needing the platform. (Bundled for Node instead, a dependency's Node build
 * is taken — `yaml`'s, which reads `process` — not the one the app runs.)
 */
const STAND_IN = /^\/\/ node:[\w/]+$|=\s*\(\(\) => \(\{\}\)\);/m;
function platformInBundles() {
  const roots = [
    ...SHARED_PACKAGES.map((name) => `packages/${name}/`),
    ...execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'packages/protocols/*/package.json', 'packages/devices/*/package.json', 'packages/services/*/package.json'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((manifest) => manifest.slice(0, -'package.json'.length)),
  ];
  const out = mkdtempSync(resolve(tmpdir(), 'kraftverk-bundle-'));
  const found = [];
  try {
    for (const root of roots) {
      let manifest;
      try {
        manifest = JSON.parse(readFileSync(resolve(ROOT, root, 'package.json'), 'utf8'));
      } catch {
        continue; // planned, not made yet
      }
      const entry = (typeof manifest.exports?.['.'] === 'string' ? manifest.exports['.'] : null) ?? manifest.main;
      if (!entry) continue;
      const outfile = resolve(out, `${root.replace(/\//g, '_')}.js`);
      try {
        execFileSync(process.execPath, [resolve(ROOT, 'scripts/run-bun.mjs'), 'build', resolve(ROOT, root, entry), '--target=browser', `--outfile=${outfile}`], { cwd: ROOT, stdio: 'pipe' });
      } catch (error) {
        found.push(`${root}: does not bundle for a browser — ${String(error.stderr ?? error.message).trim().split('\n').slice(-3).join(' ')}`);
        continue;
      }
      const bundle = readFileSync(outfile, 'utf8');
      const match = PLATFORM_MODULE.exec(bundle) ?? STAND_IN.exec(bundle);
      if (match) found.push(`${root}: its browser bundle needs a platform module (${match[0].trim()}) — a dependency needs Node or Bun`);
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
  return found;
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
  const placement = {};

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
    const wrong = misplaced(file, source);
    if (wrong) placement[file] = wrong;

    /*
      Shipped code only. A test that drives a real device type through a core
      route is not the core knowing that device — and it moves with that route
      when the route moves into the device's package. The dependency rule
      above still applies to tests.
    */
    const pattern = TEST.test(file) ? null : leakPattern(forbiddenFor(file, area), area);
    if (pattern) {
      // A pointer to a document is not knowledge in code: docs/P280-FINDINGS.md is where a finding lives.
      const count = source.replace(/docs\/[\w.-]+\.md/g, '').match(pattern)?.length ?? 0;
      if (count) leaks[file] = count;
    }
  }

  return { imports, leaks, placement };
}

// --- one API contract ----------------------------------------------------------

/**
 * The server's HTTP shapes are declared once, in the contract, and imported by
 * both sides. A shape declared again beside it is how the two drift apart
 * silently — a field added on one side only — so it fails outright, with no
 * baseline: there were never any to keep.
 */
const CONTRACT = 'packages/api-contract/src/index.ts';
const CONTRACT_USERS = /^(server\/src|client\/src|client\/app|packages\/api-client\/src)\//;

function contractCopies() {
  const declared = new Set([...readFileSync(resolve(ROOT, CONTRACT), 'utf8').matchAll(/^export (?:type|interface) (\w+)\b/gm)].map((match) => match[1]));
  const copies = [];
  for (const file of sourceFiles()) {
    if (!CONTRACT_USERS.test(file) || TEST.test(file)) continue;
    let source;
    try {
      source = readFileSync(resolve(ROOT, file), 'utf8');
    } catch {
      continue;
    }
    for (const match of source.matchAll(/^export (?:type|interface) (\w+)\b/gm)) {
      if (declared.has(match[1])) copies.push(`${file}: declares ${match[1]}, which ${CONTRACT} declares — import it from @kraftverk/api-contract`);
    }
  }
  return copies;
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

  for (const [file, why] of Object.entries(current.placement)) if (!(file in baseline.placement)) worse.push(`${file}: ${why}`);
  for (const file of Object.keys(baseline.placement)) if (!(file in current.placement)) better.push(`${file}: in its place now`);

  return { worse, better };
}

const total = (leaks) => Object.values(leaks).reduce((sum, count) => sum + count, 0);
const importCount = (imports) => Object.values(imports).reduce((sum, list) => sum + list.length, 0);

function load() {
  try {
    const raw = JSON.parse(readFileSync(BASELINE, 'utf8'));
    return { imports: raw.imports ?? {}, leaks: raw.leaks ?? {}, placement: raw.placement ?? {} };
  } catch {
    return { imports: {}, leaks: {}, placement: {} };
  }
}

function save(current) {
  const body = {
    $comment:
      'Where the architecture is still broken, file by file. May only shrink. ' +
      'See docs/ARCHITECTURE.md section 7; update with npm run check:architecture -- --update.',
    imports: current.imports,
    leaks: current.leaks,
    placement: current.placement,
  };
  writeFileSync(BASELINE, `${JSON.stringify(body, null, 2)}\n`);
}

const update = process.argv.includes('--update');
const rebaseline = process.argv.includes('--rebaseline');
const baseline = load();
const current = measure();
const { worse, better } = compare(baseline, current);

const copies = contractCopies();
if (copies.length) {
  console.error('An API shape is declared twice:\n');
  for (const line of copies) console.error(`  ✗ ${line}`);
  process.exit(1);
}

// No baseline for these: there were never any to keep.
const unplaced = unplacedPackages();
const platform = platformInBundles();
if (unplaced.length || platform.length) {
  console.error('Shared code that would not run everywhere:\n');
  for (const line of [...unplaced, ...platform]) console.error(`  ✗ ${line}`);
  process.exit(1);
}
const undocumented = undocumentedPackages();
if (undocumented.length) {
  console.error('A package that does not say what it is:\n');
  for (const line of undocumented) console.error(`  ✗ ${line}`);
  process.exit(1);
}

const summary =
  `${importCount(current.imports)} boundary exceptions, ` +
  `${total(current.leaks)} product words outside their packages (${PRODUCTS.length} packages) in ${Object.keys(current.leaks).length} files, ` +
  `${Object.keys(current.placement).length} files of logic still in the server or the app (docs/PLAN-SHARED-CORE.md)`;

/*
  Moving a file moves its leaks with it, and per file that looks like a new
  leak beside a fixed one. A rebaseline accepts the new places — but only when
  neither total rose, so a move can never smuggle in anything new.
*/
if (rebaseline) {
  const rose = [];
  if (total(current.leaks) > total(baseline.leaks)) rose.push(`identifiers ${total(baseline.leaks)} → ${total(current.leaks)}`);
  if (importCount(current.imports) > importCount(baseline.imports)) {
    rose.push(`boundary exceptions ${importCount(baseline.imports)} → ${importCount(current.imports)}`);
  }
  const misplacedCount = (placement) => Object.keys(placement).length;
  if (misplacedCount(current.placement) > misplacedCount(baseline.placement)) {
    rose.push(`files out of place ${misplacedCount(baseline.placement)} → ${misplacedCount(current.placement)}`);
  }
  if (rose.length) {
    console.error(`Refusing to rebaseline: the totals rose (${rose.join(', ')}).`);
    for (const line of worse) console.error(`  ✗ ${line}`);
    process.exit(1);
  }
  save(current);
  console.log(`Baseline recorded after a move: ${summary}.`);
  process.exit(0);
}

if (worse.length) {
  console.error('The architecture got worse:\n');
  for (const line of worse) console.error(`  ✗ ${line}`);
  console.error(
    '\nMove product knowledge into its package, and logic out of the server and the app into a shared one' +
      ' (docs/ARCHITECTURE.md §3, docs/PLAN-SHARED-CORE.md).' +
      (update ? ' --update records improvements only.' : '')
  );
  process.exit(1);
}

if (update) {
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
