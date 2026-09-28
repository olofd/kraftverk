import { validateProtocol, type Protocol } from '@kraftverk/device-sdk';

import { findPackages, load, ROOTS } from './packages.ts';

/**
 * The protocols installed on this server, found rather than listed.
 *
 * A protocol is pure code the core uses for three things: its bindings say what
 * to ask a transport for when opening a connection, and what discovery should
 * look for; its `recognise` says which sightings are its devices; its
 * credentials say what setup must ask for. The device types speak it themselves.
 */

export type Refused = { source: string; problems: string[] };

export class ProtocolRegistry {
  #protocols = new Map<string, Protocol>();
  #refused: Refused[] = [];

  async discover(roots: readonly string[] = ROOTS.protocols): Promise<void> {
    const { found, problems } = await findPackages(roots, 'protocol');
    this.#refused.push(...problems);
    for (const pkg of found) {
      try {
        this.install(await load<Protocol>(pkg, String(pkg.kraftverk.protocol)), pkg.name);
      } catch (error) {
        this.#refuse(pkg.folder, [(error as Error).message]);
      }
    }
  }

  /** Accepts one protocol, if it keeps the contract. What discovery does, and how a test brings its own. */
  install(protocol: Protocol, source = protocol.id): string[] {
    const problems = validateProtocol(protocol);
    if (!problems.length && this.#protocols.has(protocol.id)) problems.push(`another package already provides ${protocol.id}`);
    if (problems.length) {
      this.#refuse(source, problems);
      return problems;
    }
    this.#protocols.set(protocol.id, protocol);
    return [];
  }

  get(id: string): Protocol | null {
    return this.#protocols.get(id) ?? null;
  }

  all(): Protocol[] {
    return [...this.#protocols.values()];
  }

  get refused(): readonly Refused[] {
    return this.#refused;
  }

  #refuse(source: string, problems: string[]): void {
    this.#refused.push({ source, problems });
    console.warn(`[protocols] ${source} is not a usable protocol:\n  - ${problems.join('\n  - ')}`);
  }
}
