/**
 * Writes each package's catalogue, and the app's registry of installed
 * packages: client/src/generated/. See docs/ARCHITECTURE.md §3.
 *
 * The server finds integrations, device types and transports at runtime. The app
 * cannot: Metro bundles what is imported, and an app store build must not
 * download code. So this finds every installed package and writes the files
 * importing them, each for where it runs (docs/PLAN-SHARED-CORE.md, phase 6):
 *
 *   installed.ts       what a hub installs: integrations, with their protocols,
 *                      their own types and the products the device packages
 *                      on them declare, and what those bring to automations;
 *                      transport definitions — no React, so a browser's
 *                      worker builds a hub from it
 *   transports.ts      each transport's entry for a phone
 *   transports.web.ts  each transport's entry for a browser's page
 *   registry.ts        the screens and pictures device types ship, and the
 *                      screens integrations ship for their own pages
 *
 * The app runs the same code the server does, and these are the only files
 * in it that import an integration, a device package or a transport. A
 * hub's — installed.ts — imports an integration's code only when it is first
 * needed, as the server does (docs/PLAN-INTEGRATIONS.md §6.1).
 *
 * And beside each integration's and device package's package.json, its
 * catalogue.json: what it declares, as data — its types (and an
 * integration's protocols) with none of their code — which the server and
 * the app list, offer and find devices by before they import anything.
 *
 *   npm run gen:devices              write them
 *   npm run gen:devices -- --check   fail if one is out of date (CI)
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  asJson,
  deviceManifestProblems,
  entryOf,
  integrationManifestProblems,
  protocolDeclarationOf,
  type CatalogueType,
  type DeviceManifest,
  type DeviceType,
  type IntegrationManifest,
  type PackageCatalogue,
  type PackageTypeEntry,
  type Protocol,
} from '@kraftverk/device-sdk';

const ROOT = resolve(import.meta.dirname, '..');
const GENERATED = resolve(ROOT, 'client/src/generated');

type Manifest = {
  name: string;
  exports?: Record<string, string>;
  kraftverk?: {
    integration?: IntegrationManifest;
    device?: DeviceManifest;
    transport?: { definition?: string; system?: string; web?: string; native?: string };
  };
};

/** The import specifier a package exports a file under, or a clear failure. Another package's export by name is its own specifier. */
function exported(manifest: Manifest, file: string): string {
  if (file.startsWith('@kraftverk/')) return file;
  const key = Object.entries(manifest.exports ?? {}).find(([, target]) => target === file)?.[0];
  if (!key) throw new Error(`${manifest.name} must export ${file} in its package.json "exports"`);
  return key === '.' ? manifest.name : `${manifest.name}${key.slice(1)}`;
}

const local = (name: string, suffix = '') =>
  name.replace(/^@kraftverk\//, '').replace(/[^a-zA-Z0-9]+(.)/g, (_, c: string) => c.toUpperCase()) + suffix;

const fail = (message: string): never => {
  throw new Error(message);
};

function packages(parent: string): { dir: string; manifest: Manifest }[] {
  const root = resolve(ROOT, parent);
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  return entries.sort().flatMap((entry) => {
    try {
      const dir = resolve(root, entry);
      return [{ dir, manifest: JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8')) as Manifest }];
    } catch {
      return [];
    }
  });
}

/**
 * What a device image must be to go in the app: a PNG, on a transparent
 * background so it sits on a card in either theme, and small enough that a
 * list of devices does not download megabytes. It is never drawn larger than a
 * few hundred points, so 1024 pixels is room for a sharp screen with margin.
 */
const IMAGE_MAX_PX = 1024;
const IMAGE_MAX_BYTES = 512 * 1024;

function checkImage(manifest: Manifest, dir: string, file: string): void {
  const where = `${manifest.name}: ${file}`;
  let bytes: Buffer;
  try {
    bytes = readFileSync(resolve(dir, file));
  } catch {
    throw new Error(`${where} does not exist`);
  }
  const png = bytes.length > 26 && bytes.toString('latin1', 1, 4) === 'PNG';
  if (!png) throw new Error(`${where} must be a PNG`);
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const colourType = bytes[25];
  // Colour types 4 and 6 carry alpha; a palette image may carry it in a tRNS chunk.
  const transparent = colourType === 4 || colourType === 6 || bytes.includes('tRNS');
  if (!transparent) throw new Error(`${where} must have a transparent background, so it sits on a card in light and dark alike`);
  if (width > IMAGE_MAX_PX || height > IMAGE_MAX_PX) throw new Error(`${where} is ${width}×${height}; at most ${IMAGE_MAX_PX}×${IMAGE_MAX_PX} — it is never drawn larger than a few hundred points`);
  if (bytes.length > IMAGE_MAX_BYTES) throw new Error(`${where} is ${Math.round(bytes.length / 1024)} KB; at most ${IMAGE_MAX_BYTES / 1024} KB, or every list of devices downloads it`);
}

/** One file being written: its imports, and what follows them. */
type Written = { file: string; what: string; imports: string[]; body: string[] };

const HEADER = (what: string) => [
  '/*',
  '  Generated by `npm run gen:devices` from the installed packages. Do not edit:',
  '  add a package, and run it again. See scripts/gen-devices.ts.',
  '',
  `  ${what}`,
  '*/',
  '',
];

const installed: Written = { file: 'installed.ts', what: 'What a hub installs, with no screens: the app keeps its own home from this.', imports: [], body: [] };
const screens: Written = { file: 'registry.ts', what: 'The screens and pictures device types ship, and the screens integrations ship.', imports: [], body: [] };
const onPhone: Written = { file: 'transports.ts', what: 'Each transport as a phone runs it.', imports: [], body: [] };
const onPage: Written = { file: 'transports.web.ts', what: "Each transport as a browser's page runs it.", imports: [], body: [] };

const platforms: string[] = [];
let typeCount = 0;
const uis: string[] = [];
const integrationUis: string[] = [];
const pictures: string[] = [];
let protocolCount = 0;
const definitions: string[] = [];
const entries = { native: [] as string[], web: [] as string[] };

/** Each package's catalogue, by where it is written. */
const catalogues: { path: string; source: string }[] = [];

/** A package's catalogue as written: the same JSON every time, so a check can compare it. */
const catalogueSource = (catalogue: PackageCatalogue): string => `${JSON.stringify(catalogue, null, 2)}\n`;

/** One type a package lists: its catalogue entry; imported for the hub when needed, its screens and pictures for the app; its line in the integration's list. */
async function typeLine(dir: string, manifest: Manifest, entry: PackageTypeEntry, catalogue: CatalogueType[]): Promise<string> {
  const type = ((await import(pathToFileURL(resolve(dir, entry.entry)).href)) as { default?: DeviceType<any> }).default;
  if (type?.id !== entry.id) fail(`${manifest.name}: ${entry.entry} is "${type?.id}", but the manifest lists it as "${entry.id}"`);
  catalogue.push(asJson({ ...entryOf(type!), automation: Boolean(entry.automation) }));
  typeCount += 1;
  if (entry.ui) {
    screens.imports.push(`import ${local(entry.id, 'Ui')} from '${exported(manifest, entry.ui)}';`);
    uis.push(`  '${entry.id}': ${local(entry.id, 'Ui')},`);
  }
  if (entry.images?.length) {
    for (const image of entry.images) checkImage(manifest, dir, image);
    // require, not import: Metro makes each file an asset of the build, on the web and on a phone alike.
    const required = entry.images.map((image) => `require('${exported(manifest, image)}')`).join(', ');
    pictures.push(`  '${entry.id}': { images: [${required}] },`);
  }
  // Its code, imported when its integration is first needed.
  const automation = entry.automation ? `(await import('${exported(manifest, entry.automation)}')).default` : 'null';
  return `{ type: (await import('${exported(manifest, entry.entry)}')).default, automation: ${automation} }`;
}

// Each product, under the platform it names: a device package whose integration is not installed fails here, as it is refused there.
const productsOn = new Map<string, { dir: string; manifest: Manifest; device: DeviceManifest }[]>();
for (const { dir, manifest } of packages('packages/devices')) {
  const device = manifest.kraftverk?.device;
  if (!device) continue;
  const problems = deviceManifestProblems(device);
  if (problems.length) fail(`${manifest.name}: ${problems.join('; ')}`);
  productsOn.set(device.integration, [...(productsOn.get(device.integration) ?? []), { dir, manifest, device }]);
}

for (const { dir, manifest } of packages('packages/integrations')) {
  const integration = manifest.kraftverk?.integration;
  if (!integration) continue;
  const problems = integrationManifestProblems(integration);
  if (problems.length) fail(`${manifest.name}: ${problems.join('; ')}`);
  const ownCatalogue: CatalogueType[] = [];
  const own: string[] = [];
  for (const entry of integration.types) own.push(await typeLine(dir, manifest, entry, ownCatalogue));
  const products: string[] = [];
  const productCatalogue: CatalogueType[] = [];
  for (const product of productsOn.get(integration.id) ?? []) {
    const theirs: CatalogueType[] = [];
    for (const entry of product.device.types) products.push(await typeLine(product.dir, product.manifest, entry, theirs));
    catalogues.push({ path: resolve(product.dir, 'catalogue.json'), source: catalogueSource({ protocols: [], types: theirs }) });
    productCatalogue.push(...theirs);
  }
  productsOn.delete(integration.id);
  // How it speaks to its service: each protocol, declared in its catalogue, its module imported when needed.
  const declared = [];
  const spoken: string[] = [];
  for (const entry of integration.protocols ?? []) {
    const protocol = ((await import(pathToFileURL(resolve(dir, entry)).href)) as { default?: Protocol }).default;
    if (!protocol?.id) fail(`${manifest.name}: ${entry} has no default export with an id`);
    declared.push(asJson(protocolDeclarationOf(protocol!)));
    spoken.push(`(await import('${exported(manifest, entry)}')).default`);
    protocolCount += 1;
  }
  const catalogue: PackageCatalogue = { protocols: declared, types: ownCatalogue };
  catalogues.push({ path: resolve(dir, 'catalogue.json'), source: catalogueSource(catalogue) });
  // Its own screens: its page, and an account's.
  if (integration.ui) {
    screens.imports.push(`import ${local(integration.id, 'IntegrationUi')} from '${exported(manifest, integration.ui)}';`);
    integrationUis.push(`  '${integration.id}': ${local(integration.id, 'IntegrationUi')},`);
  }
  // How its entries in a file changed: what reading a file kept before brings it to now.
  const migrations = integration.migrations ? local(integration.id, 'Migrations') : null;
  if (migrations) installed.imports.push(`import ${migrations} from '${exported(manifest, integration.migrations!)}';`);
  platforms.push(
    [
      '  {',
      `    id: '${integration.id}',`,
      `    name: '${integration.name.replace(/[\\']/g, '\\$&')}',`,
      `    catalogue: ${JSON.stringify(catalogue)},`,
      `    products: ${JSON.stringify(productCatalogue)},`,
      ...(migrations ? [`    migrations: ${migrations},`] : []),
      `    load: async () => ({ protocols: [${spoken.join(', ')}], types: [${own.join(', ')}], products: [${products.join(', ')}] }),`,
      '  },',
    ].join('\n')
  );
}
for (const [id, products] of productsOn) fail(`${products.map((product) => product.manifest.name).join(', ')}: built on "${id}", which is not installed`);

for (const { dir, manifest } of packages('packages/transports')) {
  const entry = manifest.kraftverk?.transport;
  if (!entry?.definition) continue;
  installed.imports.push(`import ${local(manifest.name)} from '${exported(manifest, entry.definition)}';`);
  definitions.push(`  ${local(manifest.name)},`);
  for (const [platform, written] of [['native', onPhone], ['web', onPage]] as const) {
    const file = entry[platform];
    if (!file) continue;
    // Its definition's id, read where it is declared: the key the hub asks by.
    const definition = ((await import(pathToFileURL(resolve(dir, entry.definition)).href)) as { default?: { id?: string } }).default;
    if (!definition?.id) throw new Error(`${manifest.name}: its transport definition has no default export with an id`);
    written.imports.push(`import ${local(manifest.name)} from '${exported(manifest, file)}';`);
    entries[platform].push(`  '${definition.id}': ${local(manifest.name)},`);
  }
}

installed.body = [
  "import type { TransportDefinition } from '@kraftverk/device-sdk';",
  "import type { LazyIntegration } from '@kraftverk/hub';",
  '',
  ...installed.imports,
  '',
  '/**',
  ' * Every installed integration: its catalogue — its protocols, its own types and the products on it, as data — and its code, with what each',
  ' * type brings to automations, imported when it is first needed: the same code the server runs.',
  ' */',
  'export const INTEGRATIONS: readonly LazyIntegration[] = [',
  ...platforms,
  '];',
  '',
  "/** Every transport, as data: what the hub knows of it wherever it runs. Its entry for a place is that place's file. */",
  'export const TRANSPORTS: readonly TransportDefinition[] = [',
  ...definitions,
  '];',
  '',
];

screens.body = [
  "import type { DeviceAssets, DeviceUi } from '../features/devices/registry';",
  "import type { IntegrationUi } from '../features/integrations/registry';",
  '',
  ...screens.imports,
  '',
  '/** Screens a device type ships, by device type id. */',
  'export const DEVICE_UI: Readonly<Record<string, DeviceUi>> = {',
  ...uis,
  '};',
  '',
  '/** Pictures a device type ships, by device type id. */',
  'export const DEVICE_ASSETS: Readonly<Record<string, DeviceAssets>> = {',
  ...pictures,
  '};',
  '',
  '/** Screens an integration ships for its own pages, by integration id. */',
  'export const INTEGRATION_UI: Readonly<Record<string, IntegrationUi>> = {',
  ...integrationUis,
  '};',
  '',
];

for (const [platform, written] of [['native', onPhone], ['web', onPage]] as const) {
  written.body = [
    "import type { TransportFactory } from '@kraftverk/device-sdk';",
    '',
    ...written.imports,
    '',
    `/** Each transport that runs ${platform === 'web' ? "on a browser's page" : 'on a phone'}, by its id: one without an entry here cannot. */`,
    'export const TRANSPORT_ENTRIES: Readonly<Record<string, TransportFactory>> = {',
    ...entries[platform],
    '};',
    '',
  ];
}

const files = [
  ...[installed, screens, onPhone, onPage].map((written) => ({ path: resolve(GENERATED, written.file), source: [...HEADER(written.what), ...written.body].join('\n') })),
  ...catalogues,
].map((file) => ({ ...file, file: relative(ROOT, file.path).replaceAll('\\', '/') }));
const summary = `${platforms.length} integration(s), ${typeCount} device type(s), ${uis.length} with screens, ${pictures.length} with a picture, ${protocolCount} protocol(s), ${definitions.length} transport(s)`;

if (process.argv.includes('--check')) {
  const stale = files.filter(({ path, source }) => {
    try {
      return readFileSync(path, 'utf8').replaceAll('\r\n', '\n') !== source;
    } catch {
      return true; // missing counts as stale
    }
  });
  if (stale.length) {
    console.error(`${stale.map(({ file }) => file).join(', ')} out of date. Run: npm run gen:devices`);
    process.exit(1);
  }
  console.log(`The app's registry and every catalogue are current: ${summary}.`);
} else {
  for (const { path, source } of files) writeFileSync(path, source);
  console.log(`Wrote the app's registry and ${catalogues.length} catalogue(s): ${summary}.`);
}
