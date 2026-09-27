import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { validateDeviceType, type DeviceType } from '@kraftverk/device-sdk';

/**
 * The device types installed on this server, found rather than listed.
 *
 * A device type is a package (docs/ARCHITECTURE.md §3): one that says
 * `"kraftverk": { "deviceType": "./src/type.ts" }` in its package.json, under
 * `packages/devices` or `packages/services`. Adding one is adding the package —
 * nothing here names a product, and nothing needs editing.
 *
 * Every type is checked against the contract before it is accepted. One that
 * fails is refused and the reasons kept, so a broken package is a line in the
 * log and on the diagnostics screen rather than a device that half works; and
 * one broken package never stops the others loading.
 */

const REPOSITORY = resolve(import.meta.dirname, '../../..');
export const DEVICE_TYPE_ROOTS = ['packages/devices', 'packages/services'].map((root) => resolve(REPOSITORY, root));

export type RefusedType = { source: string; problems: string[] };

export class DeviceTypeRegistry {
  #types = new Map<string, DeviceType<any>>();
  #refused: RefusedType[] = [];

  /** Loads every device-type package under the roots. Never throws. */
  async discover(roots: readonly string[] = DEVICE_TYPE_ROOTS): Promise<void> {
    for (const root of roots) {
      let entries: string[];
      try {
        entries = await readdir(root);
      } catch {
        continue; // no services yet, say: a perfectly good installation
      }

      for (const entry of entries.sort()) {
        const dir = resolve(root, entry);
        let entryPoint: string | undefined;
        try {
          const manifest = JSON.parse(await readFile(resolve(dir, 'package.json'), 'utf8')) as {
            name?: string;
            kraftverk?: { deviceType?: string };
          };
          entryPoint = manifest.kraftverk?.deviceType;
          if (!entryPoint) continue; // a package that is not a device type — a protocol, say

          const loaded = (await import(pathToFileURL(resolve(dir, entryPoint)).href)) as { default?: DeviceType<any> };
          if (!loaded.default) throw new Error('its deviceType entry has no default export');
          this.install(loaded.default, manifest.name ?? entry);
        } catch (error) {
          this.#refuse(entry, [(error as Error).message]);
        }
      }
    }
  }

  /**
   * Accepts one type, if it keeps the contract. What discovery does for each
   * package, and how a test brings a type of its own.
   */
  install(type: DeviceType<any>, source = type.id): string[] {
    const problems = validateDeviceType(type);
    if (!problems.length && this.#types.has(type.id)) problems.push(`another package already provides ${type.id}`);
    if (problems.length) {
      this.#refuse(source, problems);
      return problems;
    }
    this.#types.set(type.id, type);
    return [];
  }

  get(id: string): DeviceType<any> | null {
    return this.#types.get(id) ?? null;
  }

  has(id: string): boolean {
    return this.#types.has(id);
  }

  all(): DeviceType<any>[] {
    return [...this.#types.values()];
  }

  /** Packages that were found and turned away, and why. */
  get refused(): readonly RefusedType[] {
    return this.#refused;
  }

  #refuse(source: string, problems: string[]): void {
    this.#refused.push({ source, problems });
    console.warn(`[devices] ${source} is not a usable device type:\n  - ${problems.join('\n  - ')}`);
  }
}
