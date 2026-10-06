import { checkContribution, type AutomationContribution } from '@kraftverk/automation';
import { connectionProblems, sourceProblem, validateDeviceType, type DeviceType, type IntegrationInfo, type Protocol, type TransportDefinition, type TypeSource } from '@kraftverk/device-sdk';

import type { Contributed } from '@kraftverk/automation-engine';

import type { Refused } from './protocols.ts';

/**
 * The integrations installed where the home runs, and the device types they
 * and the device packages on them declare — found rather than listed.
 *
 * An integration teaches a platform and a device package one product on it
 * (docs/PLAN-INTEGRATIONS.md §1): each says so in its package.json's
 * `kraftverk` section, under `packages/integrations` or `packages/devices`.
 * Adding one is adding the package — nothing here names a product, and
 * nothing needs editing. Every type keeps where it came from: the platform it
 * is on, and whether it is a product on it or the platform's own.
 *
 * Every type is checked against the contract before it is accepted. One that
 * fails is refused and the reasons kept, so a broken package is a line in the
 * log and on the diagnostics screen rather than a device that half works; and
 * one broken package never stops the others loading. A method whose protocol
 * or transport is not installed is a warning, not a refusal: the type's other
 * methods still work.
 *
 * What a package brings to automations is its own entry beside its type —
 * `"automation": "./src/automation.ts"` — namespaced by that type, and
 * checked the same way: a contribution that breaks the rules is refused, and
 * its type still installed.
 */

export class DeviceTypeRegistry {
  #integrations = new Map<string, IntegrationInfo>();
  #types = new Map<string, DeviceType<any>>();
  #sources = new Map<string, TypeSource>();
  #refused: Refused[] = [];
  #warnings = new Map<string, string[]>();
  #contributed: Contributed[] = [];

  /** Accepts an integration, before its types: one id is one platform. */
  installIntegration(integration: IntegrationInfo, source = integration.id): string[] {
    if (this.#integrations.has(integration.id)) {
      const problems = [`another package already is the integration "${integration.id}"`];
      this.refuse(source, problems);
      return problems;
    }
    this.#integrations.set(integration.id, integration);
    return [];
  }

  /**
   * Accepts one type, if it keeps the contract and comes from an installed
   * integration — as its own, in its namespace, or as a product on it. What
   * finding a package does, and how a test brings a type of its own.
   */
  install(type: DeviceType<any>, from: TypeSource, source = type.id): string[] {
    const problems = validateDeviceType(type);
    const misplaced = type.id ? sourceProblem(type.id, from) : null;
    if (misplaced) problems.push(misplaced);
    if (!this.#integrations.has(from.integration.id)) problems.push(`its integration "${from.integration.id}" is not installed`);
    if (!problems.length && this.#types.has(type.id)) problems.push(`another package already provides ${type.id}`);
    if (problems.length) {
      this.refuse(source, problems);
      return problems;
    }
    this.#types.set(type.id, type);
    this.#sources.set(type.id, from);
    return [];
  }

  /** The installed integrations, in the order they were installed. */
  integrations(): IntegrationInfo[] {
    return [...this.#integrations.values()];
  }

  /** Where an installed type came from: its platform, and whether it is a product on it. */
  sourceOf(id: string): TypeSource | null {
    return this.#sources.get(id) ?? null;
  }

  /** Accepts what an installed type's package brings to automations, if it keeps the rules. */
  contribute(type: DeviceType<any>, contribution: AutomationContribution, source = type.id): string[] {
    const problems = checkContribution(contribution, type.id);
    if (problems.length) {
      this.refuse(`${source} (what it brings to automations)`, problems);
      return problems;
    }
    this.#contributed.push({ contribution, from: { typeId: type.id, name: type.meta.name } });
    return [];
  }

  /** What the installed packages bring to automations. */
  contributions(): readonly Contributed[] {
    return this.#contributed;
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

  /** Keeps a package that was found and turned away, and why: one that would not load, say. */
  refuse(source: string, problems: string[]): void {
    this.#refused.push({ source, problems });
    console.warn(`[devices] ${source} is refused:\n  - ${problems.join('\n  - ')}`);
  }
}
