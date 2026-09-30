/**
 * Writes the app's registry of installed packages: client/src/generated/registry.ts.
 * See docs/ARCHITECTURE.md §3.
 *
 * The server finds device types, protocols and transports at runtime. The app
 * cannot: Metro bundles what is imported, and an app store build must not
 * download code. So this finds every installed package and writes one file
 * importing them — device types and their screens, protocols, and each
 * transport's definition with its web and native implementations. The app runs
 * the same code the server does for connections it holds itself, and that
 * file is the only place the app imports a device, protocol or transport.
 *
 *   npm run gen:devices              write it
 *   npm run gen:devices -- --check   fail if it is out of date (CI)
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..');
const OUTPUT = resolve(ROOT, 'client/src/generated/registry.ts');

type Manifest = {
  name: string;
  exports?: Record<string, string>;
  kraftverk?: {
    deviceType?: string;
    ui?: string;
    /** Pictures of the device, by what they are for: `image`, the device as it looks. */
    assets?: { image?: string };
    protocol?: string;
    transport?: { definition?: string; server?: string; web?: string; native?: string };
  };
};

/** The import specifier a package exports a file under, or a clear failure. */
function exported(manifest: Manifest, file: string): string {
  const key = Object.entries(manifest.exports ?? {}).find(([, target]) => target === file)?.[0];
  if (!key) throw new Error(`${manifest.name} must export ${file} in its package.json "exports"`);
  return key === '.' ? manifest.name : `${manifest.name}${key.slice(1)}`;
}

const local = (name: string, suffix = '') =>
  name.replace(/^@kraftverk\//, '').replace(/[^a-zA-Z0-9]+(.)/g, (_, c: string) => c.toUpperCase()) + suffix;

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

const imports: string[] = [];
const types: string[] = [];
const screens: string[] = [];
const assets: string[] = [];
const protocols: string[] = [];
const transports: string[] = [];

for (const { dir, manifest } of [...packages('packages/devices'), ...packages('packages/services')]) {
  const { deviceType, ui, assets: pictures } = manifest.kraftverk ?? {};
  if (!deviceType) continue;
  const type = ((await import(pathToFileURL(resolve(dir, deviceType)).href)) as { default?: { id?: string } }).default;
  if (!type?.id) throw new Error(`${manifest.name}: its deviceType entry has no default export with an id`);
  imports.push(`import ${local(manifest.name, 'Type')} from '${exported(manifest, deviceType)}';`);
  types.push(`  ${local(manifest.name, 'Type')},`);
  if (ui) {
    imports.push(`import ${local(manifest.name, 'Ui')} from '${exported(manifest, ui)}';`);
    screens.push(`  '${type.id}': ${local(manifest.name, 'Ui')},`);
  }
  if (pictures?.image) {
    checkImage(manifest, dir, pictures.image);
    // require, not import: Metro makes the file an asset of the build, on the web and on a phone alike.
    assets.push(`  '${type.id}': { image: require('${exported(manifest, pictures.image)}') },`);
  }
}

for (const { manifest } of packages('packages/protocols')) {
  const entry = manifest.kraftverk?.protocol;
  if (!entry) continue;
  imports.push(`import ${local(manifest.name)} from '${exported(manifest, entry)}';`);
  protocols.push(`  ${local(manifest.name)},`);
}

for (const { manifest } of packages('packages/transports')) {
  const entry = manifest.kraftverk?.transport;
  if (!entry?.definition) continue;
  imports.push(`import ${local(manifest.name)} from '${exported(manifest, entry.definition)}';`);
  const factory = (platform: 'web' | 'native') => {
    const file = entry[platform];
    if (!file) return 'null';
    const name = local(manifest.name, platform === 'web' ? 'Web' : 'Native');
    if (!imports.some((line) => line.startsWith(`import ${name} `))) imports.push(`import ${name} from '${exported(manifest, file)}';`);
    return name;
  };
  transports.push(`  { definition: ${local(manifest.name)}, web: ${factory('web')}, native: ${factory('native')} },`);
}

const lines = [
  '/*',
  '  Generated by `npm run gen:devices` from the installed packages. Do not edit:',
  '  add a package, and run it again. See scripts/gen-devices.ts.',
  '',
  '  The only file in the app that imports a device type, a protocol or a transport.',
  '*/',
  '',
  "import type { DeviceType, Protocol, TransportDefinition, TransportFactory } from '@kraftverk/device-sdk';",
  '',
  "import type { DeviceAssets, DeviceUi } from '../devices/ui';",
  '',
  ...imports,
  '',
  '/** Every installed device type: the same code the server runs, for connections this app holds. */',
  'export const DEVICE_TYPES: readonly DeviceType<any>[] = [',
  ...types,
  '];',
  '',
  '/** Screens a device type ships, by device type id. */',
  'export const DEVICE_UI: Readonly<Record<string, DeviceUi>> = {',
  ...screens,
  '};',
  '',
  '/** Pictures a device type ships, by device type id. */',
  'export const DEVICE_ASSETS: Readonly<Record<string, DeviceAssets>> = {',
  ...assets,
  '};',
  '',
  'export const PROTOCOLS: readonly Protocol[] = [',
  ...protocols,
  '];',
  '',
  '/** Every transport, with its implementation for each place the app runs, where it has one. */',
  'export const TRANSPORTS: readonly { definition: TransportDefinition; web: TransportFactory | null; native: TransportFactory | null }[] = [',
  ...transports,
  '];',
  '',
];
const source = lines.join('\n');
const summary = `${types.length} device type(s), ${screens.length} with screens, ${assets.length} with a picture, ${protocols.length} protocol(s), ${transports.length} transport(s)`;

if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(OUTPUT, 'utf8').replaceAll('\r\n', '\n');
  } catch {
    // missing counts as stale
  }
  if (current !== source) {
    console.error('client/src/generated/registry.ts is out of date. Run: npm run gen:devices');
    process.exit(1);
  }
  console.log(`The app's registry is current: ${summary}.`);
} else {
  writeFileSync(OUTPUT, source);
  console.log(`Wrote the app's registry: ${summary}.`);
}
