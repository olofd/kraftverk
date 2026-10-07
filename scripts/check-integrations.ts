/**
 * Measures every integration's quality against the checklist
 * (docs/PLAN-INTEGRATIONS.md §10), and writes what it measured into the
 * integration's README, between its quality markers. Measured, not
 * reviewed: each item is a check the code passes or does not.
 *
 *   npm run check:integrations              measure, and write the READMEs
 *   npm run check:integrations -- --check   fail if a README says other than what is measured (CI)
 *
 * How far a type is trusted on real hardware (`meta.support`) stays its
 * author's word: no check can say a device was in someone's hands.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  isBridgedMethod,
  isSecretField,
  validateDeviceType,
  type DeviceManifest,
  type DeviceType,
  type IntegrationManifest,
  type PackageTypeEntry,
  type Protocol,
} from '@kraftverk/device-sdk';
import { checkDeviceTypeContract } from '@kraftverk/device-sdk/testing';

const ROOT = resolve(import.meta.dirname, '..');
const check = process.argv.includes('--check');

type Manifest = { name: string; kraftverk?: { integration?: IntegrationManifest; device?: DeviceManifest } };
type Package = { dir: string; manifest: Manifest };

function packages(parent: string): Package[] {
  const root = resolve(ROOT, parent);
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .sort()
    .flatMap((entry) => {
      const file = resolve(root, entry, 'package.json');
      return existsSync(file) ? [{ dir: resolve(root, entry), manifest: JSON.parse(readFileSync(file, 'utf8')) as Manifest }] : [];
    });
}

const load = async <T>(dir: string, path: string): Promise<T> => ((await import(pathToFileURL(resolve(dir, path)).href)) as { default: T }).default;

const typesOf = (pkg: Package, entries: readonly PackageTypeEntry[]) => Promise.all(entries.map((entry) => load<DeviceType<any>>(pkg.dir, entry.entry)));

/** Whether a package has tests of its own. */
const tested = (dir: string): boolean => {
  const walk = (at: string): boolean =>
    existsSync(at) &&
    readdirSync(at, { withFileTypes: true }).some((entry) => (entry.isDirectory() ? entry.name !== 'node_modules' && walk(resolve(at, entry.name)) : entry.name.endsWith('.test.ts')));
  return walk(resolve(dir, 'src')) || walk(resolve(dir, 'test'));
};

/** One item of the checklist, measured: whether it holds, and where it does not. */
type Item = { says: string; holds: boolean; not: string[] };

const HEADINGS = ['## What it is', '## What it does — and does not', '## Where it fits', '## Why a package of its own'];
const SECRET_LIKE = /key|password|secret|token/i;
/** Transports a device announces itself on: a way over one says what it is found by. */
const ANNOUNCED = new Set(['lan', 'ble']);

async function measure(integration: Package, products: Package[]): Promise<Item[]> {
  const manifest = integration.manifest.kraftverk!.integration!;
  const protocols = await Promise.all((manifest.protocols ?? []).map((path) => load<Protocol>(integration.dir, path)));
  const types = [...(await typesOf(integration, manifest.types)), ...(await Promise.all(products.map((product) => typesOf(product, product.manifest.kraftverk!.device!.types)))).flat()];
  const all = [integration, ...products];

  const contract: string[] = [];
  for (const type of types) {
    const problems = await checkDeviceTypeContract(type, { settleMs: 300 });
    if (problems.length) contract.push(`${type.id}: ${problems[0]}`);
  }

  const meanings = types.flatMap((type) => {
    const description = type.describe(Object.fromEntries(Object.entries(type.config.fields).map(([name, field]) => [name, 'default' in field ? field.default : undefined])) as never);
    return description.attributes
      .filter((attribute) => attribute.category !== 'diagnostic' && attribute.access !== 'write' && !attribute.means && !attribute.quantity && attribute.value.type === 'number')
      .map((attribute) => `${type.id}: ${attribute.key}`);
  });

  const secrets = protocols.flatMap((protocol) =>
    Object.entries(protocol.credentials?.schema.fields ?? {})
      .filter(([name, field]) => SECRET_LIKE.test(name) && !isSecretField(field))
      .map(([name]) => `${protocol.id}: ${name}`)
  );

  const ways = types.flatMap((type) => validateDeviceType(type).map((problem) => `${type.id}: ${problem}`));

  const discovery = types.flatMap((type) =>
    type.connections.flatMap((method) => {
      if (isBridgedMethod(method) || !ANNOUNCED.has(method.transport)) return [];
      return method.discovery?.length ? [] : [`${type.id}: ${method.id}`];
    })
  );

  const untested = all.filter((pkg) => !tested(pkg.dir)).map((pkg) => pkg.manifest.name);

  const readmes = all.flatMap((pkg) => {
    const file = resolve(pkg.dir, 'README.md');
    const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
    const missing = HEADINGS.filter((heading) => !text.includes(heading));
    return missing.length ? [`${pkg.manifest.name}: ${missing.join(', ')}`] : [];
  });

  return [
    { says: 'Every type keeps the device-type contract, its simulator included', holds: !contract.length, not: contract },
    { says: 'Every value a person reads has a meaning or a quantity', holds: !meanings.length, not: meanings },
    { says: 'Every key, password or token is a secret: sealed, and left out of what is shown', holds: !secrets.length, not: secrets },
    { says: 'Every way says how far it reaches and how what it says arrives', holds: !ways.length, not: ways },
    { says: 'A device that announces itself says what it is found by', holds: !discovery.length, not: discovery },
    { says: 'Its packages have tests of their own', holds: !untested.length, not: untested },
    { says: 'Its packages say what they are', holds: !readmes.length, not: readmes },
  ];
}

const BEGIN = '<!-- quality: written by npm run check:integrations -->';
const END = '<!-- /quality -->';

function section(items: Item[]): string {
  const held = items.filter((item) => item.holds).length;
  const lines = items.map((item) => `- ${item.holds ? '✓' : '✗'} ${item.says}${item.holds ? '' : ` — not yet: ${item.not.slice(0, 3).join('; ')}${item.not.length > 3 ? ` and ${item.not.length - 3} more` : ''}`}`);
  return [BEGIN, '## Quality, measured', '', `${held} of ${items.length} (docs/PLAN-INTEGRATIONS.md §10):`, '', ...lines, END].join('\n');
}

const integrations = packages('packages/integrations').filter((pkg) => pkg.manifest.kraftverk?.integration);
const devices = packages('packages/devices').filter((pkg) => pkg.manifest.kraftverk?.device);
const stale: string[] = [];
for (const integration of integrations) {
  const id = integration.manifest.kraftverk!.integration!.id;
  const items = await measure(
    integration,
    devices.filter((device) => device.manifest.kraftverk!.device!.integration === id)
  );
  const file = resolve(integration.dir, 'README.md');
  const text = readFileSync(file, 'utf8');
  const written = section(items);
  const start = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  const next = start >= 0 && end > start ? `${text.slice(0, start)}${written}${text.slice(end + END.length)}` : `${text.trimEnd()}\n\n${written}\n`;
  if (next === text) continue;
  if (check) stale.push(`${integration.manifest.name}: its README's quality is not what is measured`);
  else writeFileSync(file, next);
}
if (stale.length) {
  console.error(`${stale.join('\n')}\nRun npm run check:integrations, and commit what it writes.`);
  process.exit(1);
}
console.log(`${check ? 'Every integration’s quality is current' : 'Measured'}: ${integrations.length} integration(s).`);
process.exit(0);
