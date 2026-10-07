import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { AutomationContribution } from '@kraftverk/automation';
import {
  deviceManifestProblems,
  integrationManifestProblems,
  type CatalogueType,
  type DeviceManifest,
  type DeviceType,
  type FileMigration,
  type IntegrationManifest,
  type PackageCatalogue,
  type PackageTypeEntry,
  type Protocol,
  type TransportDefinition,
  type TransportFactory,
} from '@kraftverk/device-sdk';
import { DeviceTypeRegistry, installIntegration, ProtocolRegistry, type InstalledType, type TransportHost } from '@kraftverk/hub';

/**
 * Finding installed packages, rather than listing them (docs/ARCHITECTURE.md §3).
 *
 * An integration, a device package or a transport is a package that says
 * so in its package.json — `"kraftverk": { "integration": { … } }` — under
 * the folder for its kind; an integration names its protocols there. Adding
 * one is adding the package: nothing here names a product, a platform, a
 * protocol or a transport, and nothing needs editing.
 *
 * What is read at start is only what each package declares: its manifest,
 * and the catalogue generated beside it (`catalogue.json`,
 * docs/PLAN-INTEGRATIONS.md §6.1). An integration's code — and the device
 * packages' on it — is imported the first time it is needed, so an
 * integration nobody uses is never imported.
 */

const REPOSITORY = resolve(import.meta.dirname, '../../..');

const ROOTS = {
  integrations: [resolve(REPOSITORY, 'packages/integrations')],
  devices: [resolve(REPOSITORY, 'packages/devices')],
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

/** A package's catalogue, as generated beside its package.json: what it declares, with none of its code. */
async function catalogueOf(pkg: FoundPackage): Promise<PackageCatalogue> {
  try {
    return JSON.parse(await readFile(resolve(pkg.dir, 'catalogue.json'), 'utf8')) as PackageCatalogue;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('it has no catalogue.json: run npm run gen:devices');
    throw error;
  }
}

/** A catalogue's types, held to what the manifest lists: one generated before the package changed is refused, saying so. */
function listedTypes(catalogue: PackageCatalogue, entries: readonly PackageTypeEntry[]): readonly CatalogueType[] {
  const listed = entries.map((entry) => entry.id).join(', ');
  const catalogued = catalogue.types.map((type) => type.id).join(', ');
  if (listed !== catalogued) throw new Error(`its catalogue.json lists ${catalogued || 'no types'}, its manifest ${listed || 'none'}: run npm run gen:devices`);
  return catalogue.types;
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

/** The types a package's manifest lists, each loaded and held to the id it is listed by, with what it brings to automations. */
async function loadTypes(pkg: FoundPackage, entries: readonly PackageTypeEntry[]): Promise<InstalledType[]> {
  const loaded: InstalledType[] = [];
  for (const entry of entries) {
    const type = await load<DeviceType<any>>(pkg, entry.entry);
    if (type.id !== entry.id) throw new Error(`${entry.entry} is "${type.id}", but the manifest lists it as "${entry.id}"`);
    loaded.push({ type, automation: entry.automation ? await load<AutomationContribution>(pkg, entry.automation) : null });
  }
  return loaded;
}

/**
 * Every integration, with its protocols, its own types and the products the
 * device packages built on it declare (docs/PLAN-INTEGRATIONS.md §1), each with
 * what it brings to automations — declared from their catalogues, their code
 * loaded when it is first needed. A device package whose integration is not
 * installed is refused, saying so: a product is reached only through its
 * platform. How an integration's entries in a file changed is read at once:
 * a file kept before is read as soon as the home starts.
 */
export async function discoverIntegrations(
  { types, protocols }: { types: DeviceTypeRegistry; protocols: ProtocolRegistry },
  roots: { integrations: readonly string[]; devices: readonly string[] } = ROOTS
): Promise<void> {
  const platforms = await findPackages(roots.integrations, 'integration');
  const products = await findPackages(roots.devices, 'device');
  for (const problem of [...platforms.problems, ...products.problems]) types.refuse(problem.source, problem.problems);

  // Each product, declared from its catalogue and grouped under the platform it names; its code loads with the platform's.
  const onPlatform = new Map<string, { pkg: FoundPackage; declared: readonly CatalogueType[]; load: () => Promise<InstalledType[]> }[]>();
  for (const pkg of products.found) {
    const problems = deviceManifestProblems(pkg.kraftverk.device);
    if (problems.length) {
      types.refuse(pkg.folder, problems);
      continue;
    }
    const manifest = pkg.kraftverk.device as DeviceManifest;
    try {
      const declared = listedTypes(await catalogueOf(pkg), manifest.types);
      onPlatform.set(manifest.integration, [...(onPlatform.get(manifest.integration) ?? []), { pkg, declared, load: () => loadTypes(pkg, manifest.types) }]);
    } catch (error) {
      types.refuse(pkg.folder, [(error as Error).message]);
    }
  }

  for (const pkg of platforms.found) {
    const problems = integrationManifestProblems(pkg.kraftverk.integration);
    if (problems.length) {
      types.refuse(pkg.folder, problems);
      continue;
    }
    const manifest = pkg.kraftverk.integration as IntegrationManifest;
    try {
      const catalogue = await catalogueOf(pkg);
      listedTypes(catalogue, manifest.types);
      const built = onPlatform.get(manifest.id) ?? [];
      onPlatform.delete(manifest.id);
      const migrations = manifest.migrations ? await load<FileMigration[]>(pkg, manifest.migrations) : [];
      installIntegration(
        { types, protocols },
        {
          id: manifest.id,
          name: manifest.name,
          catalogue,
          products: built.flatMap((product) => product.declared),
          migrations,
          load: async () => ({
            protocols: await Promise.all((manifest.protocols ?? []).map((path) => load<Protocol>(pkg, path))),
            types: await loadTypes(pkg, manifest.types),
            // One product that will not load is refused alone: the platform, and the other products on it, still load.
            products: (
              await Promise.all(
                built.map((product) =>
                  product.load().catch((error: unknown) => {
                    types.refuse(product.pkg.folder, [`its code would not load: ${(error as Error).message}`]);
                    return [];
                  })
                )
              )
            ).flat(),
          }),
        },
        pkg.name
      );
    } catch (error) {
      types.refuse(pkg.folder, [(error as Error).message]);
    }
  }

  for (const [integration, built] of onPlatform) {
    for (const { pkg } of built) types.refuse(pkg.folder, [`its integration "${integration}" is not installed`]);
  }
}

/**
 * What is installed: transports, integrations with their protocols, and the
 * device packages on them, each found in its folder under `packages/` rather than
 * listed (docs/ARCHITECTURE.md §3),
 * and each type's ways checked against what is there. The transports are
 * found into the host that will start them.
 */
export async function installedFromDisk(transports: TransportHost): Promise<{ types: DeviceTypeRegistry; protocols: ProtocolRegistry; transports: TransportHost }> {
  const protocols = new ProtocolRegistry();
  const types = new DeviceTypeRegistry();
  await Promise.all([discoverTransports(transports), discoverIntegrations({ types, protocols })]);
  types.checkConnections({ protocols, transport: (id) => transports.definition(id) });
  console.log(
    `[devices] Installed: integrations ${types.integrations().map((integration) => integration.id).join(', ') || 'none'}; ` +
      `device types ${types.all().map((type) => type.id).join(', ') || 'none'} (each loaded when first needed); ` +
      `protocols ${protocols.all().map((protocol) => protocol.id).join(', ') || 'none'}; ` +
      `transports ${transports.definitions().map((definition) => definition.id).join(', ') || 'none'}`
  );
  return { types, protocols, transports };
}
