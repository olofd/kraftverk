import { connectionProblems, validateDeviceType, type DeviceType, type Protocol, type TransportDefinition } from '@kraftverk/device-sdk';

import { findPackages, load, ROOTS } from '../runtime/packages.ts';
import type { Refused } from '../runtime/protocols.ts';

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
 * one broken package never stops the others loading. A method whose protocol
 * or transport is not installed is a warning, not a refusal: the type's other
 * methods still work.
 */

export class DeviceTypeRegistry {
  #types = new Map<string, DeviceType<any>>();
  #refused: Refused[] = [];
  #warnings = new Map<string, string[]>();

  /** Loads every device-type package under the roots. Never throws. */
  async discover(roots: readonly string[] = ROOTS.deviceTypes): Promise<void> {
    const { found, problems } = await findPackages(roots, 'deviceType');
    this.#refused.push(...problems);
    for (const pkg of found) {
      try {
        this.install(await load<DeviceType<any>>(pkg, String(pkg.kraftverk.deviceType)), pkg.name);
      } catch (error) {
        this.#refuse(pkg.folder, [(error as Error).message]);
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

  /** Checks every type's methods against what is installed, and keeps what does not fit. */
  checkConnections(installed: { protocol(id: string): Protocol | null; transport(id: string): TransportDefinition | null }): void {
    this.#warnings.clear();
    for (const type of this.#types.values()) {
      const problems = connectionProblems(type, installed);
      if (!problems.length) continue;
      this.#warnings.set(type.id, problems);
      console.warn(`[devices] ${type.id}:\n  - ${problems.join('\n  - ')}`);
    }
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
  get refused(): readonly Refused[] {
    return this.#refused;
  }

  /** Methods of installed types that name something not installed. */
  warnings(id: string): readonly string[] {
    return this.#warnings.get(id) ?? [];
  }

  #refuse(source: string, problems: string[]): void {
    this.#refused.push({ source, problems });
    console.warn(`[devices] ${source} is not a usable device type:\n  - ${problems.join('\n  - ')}`);
  }
}
