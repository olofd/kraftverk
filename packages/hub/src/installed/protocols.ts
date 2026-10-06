import type { Refused } from '@kraftverk/api-contract';
import { protocolProblem, validateProtocol, type Protocol } from '@kraftverk/device-sdk';

/**
 * The protocols installed in this home, each part of the integration that
 * brought it (docs/PLAN-INTEGRATIONS.md §1.1) and installed with it.
 *
 * A protocol is pure code the core uses for three things: its bindings say what
 * to ask a transport for when opening a connection, and what discovery should
 * look for; its `recognise` says which sightings are its devices; its
 * credentials say what setup must ask for. The device types speak it themselves.
 */

export type { Refused };

export class ProtocolRegistry {
  #protocols = new Map<string, Protocol>();
  #integrations = new Map<string, string>();
  #refused: Refused[] = [];

  /**
   * Accepts one protocol of an integration's, if it keeps the contract and
   * is named as that integration's (`acme-cloud` is Acme's). What installing
   * an integration does.
   */
  install(protocol: Protocol, integration: string, source = protocol.id): string[] {
    const problems = validateProtocol(protocol);
    const named = protocolProblem(protocol.id, integration);
    if (named) problems.push(named);
    if (!problems.length && this.#protocols.has(protocol.id)) problems.push(`another package already provides ${protocol.id}`);
    if (problems.length) {
      this.refuse(source, problems);
      return problems;
    }
    this.#protocols.set(protocol.id, protocol);
    this.#integrations.set(protocol.id, integration);
    return [];
  }

  get(id: string): Protocol | null {
    return this.#protocols.get(id) ?? null;
  }

  /** The integration a protocol is part of: a way of reaching a device speaks only its own integration's. */
  integrationOf(id: string): string | null {
    return this.#integrations.get(id) ?? null;
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
