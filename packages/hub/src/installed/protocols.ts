import type { Refused } from '@kraftverk/api-contract';
import { validateProtocol, type Protocol } from '@kraftverk/device-sdk';

/**
 * The protocols installed in this home: found by the place it runs — the
 * server on its disk, the app in its generated registry — and installed here.
 *
 * A protocol is pure code the core uses for three things: its bindings say what
 * to ask a transport for when opening a connection, and what discovery should
 * look for; its `recognise` says which sightings are its devices; its
 * credentials say what setup must ask for. The device types speak it themselves.
 */

export type { Refused };

export class ProtocolRegistry {
  #protocols = new Map<string, Protocol>();
  #refused: Refused[] = [];

  /** Accepts one protocol, if it keeps the contract. What finding one does, and how a test brings its own. */
  install(protocol: Protocol, source = protocol.id): string[] {
    const problems = validateProtocol(protocol);
    if (!problems.length && this.#protocols.has(protocol.id)) problems.push(`another package already provides ${protocol.id}`);
    if (problems.length) {
      this.refuse(source, problems);
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

  /** Keeps a package that was found and turned away, and why: one that would not load, say. */
  refuse(source: string, problems: string[]): void {
    this.#refused.push({ source, problems });
    console.warn(`[protocols] ${source} is not a usable protocol:\n  - ${problems.join('\n  - ')}`);
  }
}
