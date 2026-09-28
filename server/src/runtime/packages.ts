import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Finding installed packages, rather than listing them (docs/ARCHITECTURE.md §3).
 *
 * A device type, a protocol or a transport is a package that says so in its
 * package.json — `"kraftverk": { "protocol": "./src/index.ts" }` — under the
 * folder for its kind. Adding one is adding the package: nothing here names a
 * product, a protocol or a transport, and nothing needs editing.
 */

export const REPOSITORY = resolve(import.meta.dirname, '../../..');

export const ROOTS = {
  deviceTypes: ['packages/devices', 'packages/services'].map((root) => resolve(REPOSITORY, root)),
  protocols: [resolve(REPOSITORY, 'packages/protocols')],
  transports: [resolve(REPOSITORY, 'packages/transports')],
} as const;

export type FoundPackage = {
  /** The folder's name, for messages. */
  folder: string;
  /** The package's name. */
  name: string;
  dir: string;
  /** Its `kraftverk` section. */
  kraftverk: Record<string, unknown>;
};

/** Every package under `roots` whose `kraftverk` section has `key`. Never throws. */
export async function findPackages(roots: readonly string[], key: string): Promise<{ found: FoundPackage[]; problems: { source: string; problems: string[] }[] }> {
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
export async function load<T>(pkg: FoundPackage, path: string): Promise<T> {
  const loaded = (await import(pathToFileURL(resolve(pkg.dir, path)).href)) as { default?: T };
  if (!loaded.default) throw new Error(`${path} has no default export`);
  return loaded.default;
}
