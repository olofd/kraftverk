import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { AutomationContribution } from '@kraftverk/automation';
import type { DeviceType, Protocol, TransportDefinition, TransportFactory } from '@kraftverk/device-sdk';
import { DeviceTypeRegistry, ProtocolRegistry, type TransportHost } from '@kraftverk/hub';

/**
 * Finding installed packages, rather than listing them (docs/ARCHITECTURE.md §3).
 *
 * A device type, a protocol or a transport is a package that says so in its
 * package.json — `"kraftverk": { "protocol": "./src/index.ts" }` — under the
 * folder for its kind. Adding one is adding the package: nothing here names a
 * product, a protocol or a transport, and nothing needs editing.
 */

const REPOSITORY = resolve(import.meta.dirname, '../../..');

const ROOTS = {
  deviceTypes: ['packages/devices', 'packages/services'].map((root) => resolve(REPOSITORY, root)),
  protocols: [resolve(REPOSITORY, 'packages/protocols')],
  transports: [resolve(REPOSITORY, 'packages/transports')],
} as const;

type FoundPackage = {
  /** The folder's name, for messages. */
  folder: string;
  /** The package's name. */
  name: string;
  dir: string;
  /** Its `kraftverk` section. */
  kraftverk: Record<string, unknown>;
};

/** Every package under `roots` whose `kraftverk` section has `key`. Never throws. */
async function findPackages(roots: readonly string[], key: string): Promise<{ found: FoundPackage[]; problems: { source: string; problems: string[] }[] }> {
  const found: FoundPackage[] = [];
  const problems: { source: string; problems: string[] }[] = [];
  for (const root of roots) {
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch {
      continue; // no services yet, say: a perfectly good installation
    }
    for (const entry of entries.sort()) {
      const dir = resolve(root, entry);
      try {
        const manifest = JSON.parse(await readFile(resolve(dir, 'package.json'), 'utf8')) as { name?: string; kraftverk?: Record<string, unknown> };
        if (!manifest.kraftverk || !(key in manifest.kraftverk)) continue;
        found.push({ folder: entry, name: manifest.name ?? entry, dir, kraftverk: manifest.kraftverk });
      } catch (error) {
        // A folder with no package.json is not a package; one that will not parse is a problem.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') problems.push({ source: entry, problems: [(error as Error).message] });
      }
    }
  }
  return { found, problems };
}

/** A package's module, by a path from its own folder. */
async function load<T>(pkg: FoundPackage, path: string): Promise<T> {
  const loaded = (await import(pathToFileURL(resolve(pkg.dir, path)).href)) as { default?: T };
  if (!loaded.default) throw new Error(`${path} has no default export`);
  return loaded.default;
}

/*
  What the server has installed, found on its disk and installed into the
  home's registries (@kraftverk/hub). The app does the same from its generated
  registry. Each never throws: a package that will not load is refused, with
  why, and the others still load.
*/

export async function discoverProtocols(protocols: ProtocolRegistry, roots: readonly string[] = ROOTS.protocols): Promise<void> {
  const { found, problems } = await findPackages(roots, 'protocol');
  for (const problem of problems) protocols.refuse(problem.source, problem.problems);
  for (const pkg of found) {
    try {
      protocols.install(await load<Protocol>(pkg, String(pkg.kraftverk.protocol)), pkg.name);
    } catch (error) {
      protocols.refuse(pkg.folder, [(error as Error).message]);
    }
  }
}

/** Every transport's definition, and its server entry when it has one: loaded only when it starts. */
export async function discoverTransports(transports: TransportHost, roots: readonly string[] = ROOTS.transports): Promise<void> {
  const { found, problems } = await findPackages(roots, 'transport');
  for (const problem of problems) transports.refuse(problem.source, problem.problems);
  for (const pkg of found) {
    const entries = pkg.kraftverk.transport as { definition?: string; system?: string } | undefined;
    try {
      if (!entries?.definition) throw new Error('its transport entry names no definition');
      const definition = await load<TransportDefinition>(pkg, entries.definition);
      transports.install(definition, entries.system ? { load: () => load<TransportFactory>(pkg, entries.system!) } : null, pkg.name);
    } catch (error) {
      transports.refuse(pkg.folder, [(error as Error).message]);
    }
  }
}

/** Every device type, and what its package brings to automations beside it. */
export async function discoverDeviceTypes(types: DeviceTypeRegistry, roots: readonly string[] = ROOTS.deviceTypes): Promise<void> {
  const { found, problems } = await findPackages(roots, 'deviceType');
  for (const problem of problems) types.refuse(problem.source, problem.problems);
  for (const pkg of found) {
    try {
      const type = await load<DeviceType<any>>(pkg, String(pkg.kraftverk.deviceType));
      if (types.install(type, pkg.name).length) continue;
      if (pkg.kraftverk.automation) types.contribute(type, await load<AutomationContribution>(pkg, String(pkg.kraftverk.automation)), pkg.name);
    } catch (error) {
      types.refuse(pkg.folder, [(error as Error).message]);
    }
  }
}

/**
 * What is installed: protocols, transports and device types, each found in
 * its folder under `packages/` rather than listed (docs/ARCHITECTURE.md §3),
 * and each type's ways checked against what is there. The transports are
 * found into the host that will start them.
 */
export async function installedFromDisk(transports: TransportHost): Promise<{ types: DeviceTypeRegistry; protocols: ProtocolRegistry; transports: TransportHost }> {
  const protocols = new ProtocolRegistry();
  const types = new DeviceTypeRegistry();
  await Promise.all([discoverProtocols(protocols), discoverTransports(transports), discoverDeviceTypes(types)]);
  types.checkConnections({ protocol: (id) => protocols.get(id), transport: (id) => transports.definition(id) });
  console.log(
    `[devices] Installed: ${types.all().map((type) => type.id).join(', ') || 'no device types'}; ` +
      `protocols ${protocols.all().map((protocol) => protocol.id).join(', ') || 'none'}; ` +
      `transports ${transports.definitions().map((definition) => definition.id).join(', ') || 'none'}`
  );
  return { types, protocols, transports };
}
