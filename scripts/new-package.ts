/**
 * Starts a new integration, device package, protocol or transport: a package
 * that works, keeps its contract and passes the architecture check on the
 * first run, for you to make true. See docs/ADDING-A-DEVICE.md.
 *
 *   npm run new:integration -- acme           packages/integrations/acme      a platform
 *   npm run new:device -- acme-plug acme      packages/devices/acme-plug      a product on it
 *   npm run new:protocol -- acme              packages/protocols/acme
 *   npm run new:transport -- zigbee           packages/transports/zigbee
 *
 * Nothing else needs editing: the server finds the package at start, and
 * `npm run gen:devices` binds it into the app.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const [kind, name, platform] = process.argv.slice(2);
const NAME = /^[a-z][a-z0-9-]{1,40}$/;

if (!kind || !['integration', 'device', 'protocol', 'transport'].includes(kind) || !name || !NAME.test(name) || (kind === 'device' && !(platform && NAME.test(platform)))) {
  console.error('Usage: npm run new:integration|new:protocol|new:transport -- <name>');
  console.error('       npm run new:device -- <name> <the integration it is built on>');
  console.error('Names are lower-case with dashes.');
  process.exit(1);
}
if (kind === 'device' && !existsSync(resolve(ROOT, 'packages/integrations', platform!, 'package.json'))) {
  console.error(`packages/integrations/${platform} is not there: a product is built on an integration — make it first (npm run new:integration -- ${platform})`);
  process.exit(1);
}

const folder = { integration: 'integrations', device: 'devices', protocol: 'protocols', transport: 'transports' }[kind]!;
const dir = resolve(ROOT, 'packages', folder, name);
if (existsSync(dir)) {
  console.error(`packages/${folder}/${name} already exists`);
  process.exit(1);
}

const words = name.split('-');
const title = words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
const id = words.join('.');
/** The constant an integration's ways in are exported as: `ACME_WAYS`. */
const waysOf = (integration: string) => `${integration.toUpperCase().replace(/-/g, '_')}_WAYS`;

const TSCONFIG = `{
  "compilerOptions": {
    "lib": ["ESNext", "DOM"],
    "target": "ESNext",
    "module": "Preserve",
    "moduleResolution": "bundler",
    "types": ["bun"],

    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "noEmit": true,

    "strict": true,
    "noUnusedLocals": true,
    "noUncheckedIndexedAccess": true,
    "noFallthroughCasesInSwitch": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
`;

const manifest = (packageName: string, description: string, kraftverk: Record<string, unknown>, exports: Record<string, string>, dependencies: Record<string, string> = {}) =>
  `${JSON.stringify(
    {
      name: packageName,
      version: '0.1.0',
      private: true,
      description,
      type: 'module',
      main: Object.values(exports)[0],
      kraftverk,
      exports,
      scripts: { test: 'node ../../../scripts/run-bun.mjs test', typecheck: 'tsc --noEmit' },
      dependencies: { '@kraftverk/device-sdk': '*', ...dependencies },
      devDependencies: { '@types/bun': '^1.3.14', typescript: '^7.0.2' },
    },
    null,
    2
  )}\n`;

const files: Record<string, string> = {};

if (kind === 'integration') {
  files['package.json'] = manifest(
    `@kraftverk/integration-${name}`,
    `${title} as a platform: how things on it are reached, signed into and found. Describe it.`,
    { integration: { id: name, name: title, types: [] } },
    { '.': './src/index.ts' }
  );
  files['src/index.ts'] = `import type { ConnectionMethod } from '@kraftverk/device-sdk';

/**
 * ${title} as a platform. See docs/ADDING-A-DEVICE.md.
 *
 * What every product on it shares: the ways it is reached — its protocol over
 * a transport — and, as they come, their setup, its accounts and gateways,
 * the builder its products are made with, and a generic type for a product
 * nobody has described. It names no product: each is a device package built on
 * this one.
 */

/** Every way a thing on ${title} is reached. Its protocol is \`@kraftverk/protocol-${name}\` (npm run new:protocol -- ${name}). */
export const ${waysOf(name)}: readonly ConnectionMethod[] = [{ id: 'lan', label: 'Home network', protocol: '${name}', transport: 'lan', reach: 'local' }];
`;
  files['test/ways.test.ts'] = `import { expect, test } from 'bun:test';

import { ${waysOf(name)} } from '../src/index.ts';

test('a thing on ${title} is reached at least one way', () => {
  expect(${waysOf(name)}.length).toBeGreaterThan(0);
});
`;
}

if (kind === 'device') {
  const ways = waysOf(platform!);
  const offersWays = readFileSync(resolve(ROOT, 'packages/integrations', platform!, 'src/index.ts'), 'utf8').includes(`export const ${ways}`);
  // Without ways to take, a way of its own over the protocol its platform is built on: to be made true.
  const platformManifest = JSON.parse(readFileSync(resolve(ROOT, 'packages/integrations', platform!, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
  const spoken = Object.keys(platformManifest.dependencies ?? {}).find((dependency) => dependency.startsWith('@kraftverk/protocol-'))?.slice('@kraftverk/protocol-'.length) ?? platform!;
  files['package.json'] = manifest(
    `@kraftverk/device-${name}`,
    `The ${title}, a product on ${platform}. Describe what it is.`,
    { device: { integration: platform, types: [{ id: `community.${id}`, entry: './src/type.ts' }] } },
    { '.': './src/type.ts', './type': './src/type.ts' },
    // The protocol it speaks itself, when it takes no ways from its platform: one its platform is built on.
    { [`@kraftverk/integration-${platform}`]: '*', ...(!offersWays && spoken !== platform ? { [`@kraftverk/protocol-${spoken}`]: '*' } : {}) }
  );
  files['src/type.ts'] = `import { defineDeviceType, MAIN_PART, type DeviceContext, type DeviceDescription, type DeviceSession, type Reading } from '@kraftverk/device-sdk';
${offersWays ? `import { ${ways} } from '@kraftverk/integration-${platform}';\n` : ''}
/**
 * The ${title}, a product on ${platform}. See docs/ADDING-A-DEVICE.md.
 *
 * Start from the simulator: it keeps the contract with no hardware, and it is
 * what the tests and "try without hardware" use. It is reached the ways its
 * integration offers; what is its own is what it is — its parts, what each
 * reports and takes, its models and pictures.
 */`;
  files['src/type.ts'] += DEVICE_BODY(offersWays ? `  // Reached the ways every product on ${platform} is: its integration's.\n  connections: ${ways},` : `  // A way of its own, over the protocol ${platform} is built on — or its integration's ways, once it exports them as ${ways}.\n  connections: [{ id: 'lan', label: 'Home network', protocol: '${spoken}', transport: 'lan', reach: 'local' }],`);

function DEVICE_BODY(connections: string): string {
  return `

type Config = Record<string, never>;

/**
 * What it is: its parts, what each reports and what each takes. One part here,
 * \`main\`, which reports whether it is on and offers \`switch\` — so it takes
 * \`switch.set\`, and the gateway checks it by reading \`on\` back.
 */
const DESCRIPTION: DeviceDescription = {
  parts: [{ id: MAIN_PART, label: '${title}', kind: 'outlet', energy: { role: 'load' }, offers: ['switch'] }],
  attributes: [{ key: 'on', label: 'On', value: { type: 'boolean' }, means: 'on' }],
};

/** A simulated ${title}: a switch that remembers where it was left. */
function simulatedSession(ctx: DeviceContext<Config>): DeviceSession {
  let on = ctx.store.get<boolean>('on') ?? true;
  let at = new Date().toISOString();
  return {
    health: () => ({ status: 'connected', detail: 'Simulated', lastReadingAt: at }),
    readings: (): Reading[] => [{ key: 'on', value: on, at }],
    async command(request) {
      if (request.capability !== 'switch' || typeof request.args.on !== 'boolean') return { accepted: false, error: 'It only switches' };
      if (ctx.readOnly) return { accepted: false, error: 'Read-only' };
      on = request.args.on;
      at = new Date().toISOString();
      ctx.store.set('on', on);
      return { accepted: true };
    },
    close: async () => {},
  };
}

export default defineDeviceType<Config>({
  id: 'community.${id}',
  kind: 'hardware',
  meta: {
    name: '${title}',
    category: 'smart-plug',
    description: 'What it is, in one sentence.',
    support: 'experimental',
    supportNote: 'Nobody has run it against real hardware yet.',
    icon: 'power',
  },
  config: { fields: {} },
  describe: () => DESCRIPTION,
${connections}

  async identify() {
    throw new Error('Reading a real ${title} is not written yet');
  },
  async createSession() {
    throw new Error('Reaching a real ${title} is not written yet: it runs as a simulator');
  },
  async createSimulator(ctx) {
    return simulatedSession(ctx);
  },
});
`;
}
  files['test/contract.test.ts'] = `import { expect, test } from 'bun:test';

import { checkDeviceTypeContract } from '@kraftverk/device-sdk/testing';

import type_ from '../src/type.ts';

test('the ${title} keeps the device-type contract', async () => {
  expect(await checkDeviceTypeContract(type_)).toEqual([]);
});
`;
}

if (kind === 'protocol') {
  files['package.json'] = manifest(
    `@kraftverk/protocol-${name}`,
    `The ${title} protocol: framing and meaning of its bytes. Pure code, over whatever transport it rides.`,
    { protocol: './src/index.ts' },
    { '.': './src/index.ts' }
  );
  files['src/index.ts'] = `import type { Protocol, Sighting } from '@kraftverk/device-sdk';

/**
 * The ${title} protocol. See docs/ADDING-A-DEVICE.md.
 *
 * Pure: bytes and messages in, bytes and messages out, no I/O and no Node or
 * Bun built-ins, because it runs in the app as well as on the server. It has
 * a binding for each transport it rides, and no idea what product it serves.
 */
const protocol: Protocol = {
  id: '${name}',
  label: '${title}',
  bindings: {
    lan: {
      open: () => ({ port: 6668 }),
      // Whether something the transport saw is one of this protocol's devices.
      recognise: (sighting: Sighting) => (sighting.facts.protocol === '${name}' ? { name: sighting.name ?? sighting.address } : null),
      parseAddress: (input) => (/^\\d{1,3}(\\.\\d{1,3}){3}$/.test(input.trim()) ? input.trim() : null),
      addressLabel: 'IP address',
    },
  },
};

export default protocol;
`;
  files['test/protocol.test.ts'] = `import { expect, test } from 'bun:test';

import { validateProtocol } from '@kraftverk/device-sdk';

import protocol from '../src/index.ts';

test('the ${title} protocol is a valid protocol', () => {
  expect(validateProtocol(protocol)).toEqual([]);
});
`;
}

if (kind === 'transport') {
  files['package.json'] = manifest(
    `@kraftverk/transport-${name}`,
    `${title}: moves bytes or messages to a device, and finds devices. Knows no protocol.`,
    { transport: { definition: './src/index.ts', system: './src/system.ts' } },
    { '.': './src/index.ts', './system': './src/system.ts' }
  );
  files['src/index.ts'] = `import type { TransportDefinition } from '@kraftverk/device-sdk';

/**
 * ${title}, the same on every platform. See docs/ADDING-A-DEVICE.md.
 * Where it has an implementation is \`platforms\`, and each one is an entry of
 * its own (\`system\`, \`web\`, \`native\`), so the app never bundles a system process's code.
 */
const definition: TransportDefinition = {
  id: '${name}',
  label: '${title.toLowerCase()}',
  channel: 'bytes',
  exclusive: true,
  // Reached only within a radio's range of whoever holds it, as Bluetooth is: then true.
  nearby: false,
  platforms: ['system'],
  discovery: { system: 'none' },
};

export default definition;
`;
  files['src/system.ts'] = `import type { Transport, TransportFactory } from '@kraftverk/device-sdk';

import definition from './index.ts';

/** ${title} in a system process: a node on a machine. Started once, shared by every connection over it. */
const create${words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join('')}: TransportFactory = (): Transport => ({
  definition,
  available: () => ({ ok: false, reason: '${title} is not written yet' }),
  async start() {},
  async stop() {},
  async open() {
    throw new Error('${title} is not written yet');
  },
});

export default create${words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join('')};
`;
  files['test/transport.test.ts'] = `import { expect, test } from 'bun:test';

import { validateTransportDefinition } from '@kraftverk/device-sdk';

import definition from '../src/index.ts';

test('${title} is a valid transport', () => {
  expect(validateTransportDefinition(definition)).toEqual([]);
});
`;
}

files['tsconfig.json'] = TSCONFIG;

/** What every package's README says, under the headings the architecture check asks for: to be written as the package is. */
const SAYS = {
  integration: {
    is: `${title} as a platform: how things on it are reached, signed into and found, apart from any one product.`,
    fits: 'An integration (docs/PLAN-INTEGRATIONS.md §1): it imports the SDK, the language and its protocols, and names no product; device packages build on it; the server finds it by its package.json, the app through the generated registry.',
    why: 'Because what every product on a platform shares is written once, and each product is then a small package of its own.',
  },
  device: {
    is: `The ${title}, a product on ${platform}: what it measures, what it can do, its settings, its models and pictures.`,
    fits: `A device package (docs/PLAN-INTEGRATIONS.md §1): built on the ${platform} integration, importing it, the SDK and its protocols; the server finds it by its package.json, the app through the generated registry.`,
    why: 'Because device-specific code stays in its package and the core names no product (AGENTS.md).',
  },
  protocol: {
    is: `The ${title} protocol: what goes over a channel, and how to read what comes back.`,
    fits: 'A protocol (docs/ARCHITECTURE.md §3): pure, importing only the SDK. Device types use it; transports carry its bytes.',
    why: 'Because a protocol is shared by every device that speaks it, and tested on its frames alone.',
  },
  transport: {
    is: `${title}: a way kraftverk reaches devices, with an entry for each place it runs.`,
    fits: 'A transport (docs/ARCHITECTURE.md §3): the platform layer, importing only the SDK. Holders open its channels; protocols speak over them.',
    why: 'Because platform code lives in transports, and nothing else touches a platform API.',
  },
}[kind]!;
files['README.md'] = `# @kraftverk/${kind}-${name}

## What it is

${SAYS.is}

## What it does — and does not

- **Does:** (say what it does, as it is written.)
- **Does not:** (say what it leaves to other packages.)

## Where it fits

${SAYS.fits}

## Why a package of its own

${SAYS.why}
`;

for (const [path, content] of Object.entries(files)) {
  const target = resolve(dir, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

console.log(`Created packages/${folder}/${name}. Next:`);
console.log('  npm install                 link it into the workspace');
console.log(`  npm test --workspace @kraftverk/${kind}-${name}`);
if (kind === 'integration') console.log(`  npm run new:protocol -- ${name}   the protocol its ways speak, if it is new`);
if (kind === 'integration' || kind === 'device') console.log('  npm run gen:devices         bind it into the app');
console.log('  docs/ADDING-A-DEVICE.md     what to make true next');
