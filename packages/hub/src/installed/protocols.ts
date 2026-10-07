import type { Refused } from '@kraftverk/api-contract';
import { protocolDeclarationOf, protocolProblem, validateProtocol, type Protocol, type ProtocolDeclaration } from '@kraftverk/device-sdk';

/**
 * The protocols installed in this home, each part of the integration that
 * brought it (docs/PLAN-INTEGRATIONS.md §1.1) and installed with it.
 *
 * A protocol is pure code the core uses for three things: its bindings say what
 * to ask a transport for when opening a connection; its `recognise` confirms
 * which sightings are its devices; its credentials say what setup must ask
 * for. The device types speak it themselves.
 *
 * As a type is (types.ts), a protocol is kept twice: its **declaration** —
 * its bindings' instructions and labels, its credentials' schema — from its
 * integration's catalogue, from the start; its **code** once its integration
 * has loaded (`load`), for opening, recognising and guarding.
 */

export type { Refused };

export class ProtocolRegistry {
  #declarations = new Map<string, ProtocolDeclaration>();
  #protocols = new Map<string, Protocol>();
  #integrations = new Map<string, string>();
  #refused: Refused[] = [];
  #loader: (integration: string) => Promise<boolean> = async () => false;

  /** How an integration's code is loaded: its types' registry's, so a type and its protocols load as one. */
  loadsWith(loader: (integration: string) => Promise<boolean>): void {
    this.#loader = loader;
  }

  /** The problems with a protocol's place: named as its integration's, and not another's id. */
  #placeProblems(id: string, integration: string): string[] {
    const named = protocolProblem(id, integration);
    return [...(named ? [named] : []), ...(this.#declarations.has(id) ? [`another package already provides ${id}`] : [])];
  }

  /** Accepts one protocol's declaration, from its integration's catalogue: its code comes with the integration's. */
  declare(declaration: ProtocolDeclaration, integration: string, source = declaration.id): string[] {
    const problems = this.#placeProblems(declaration.id, integration);
    if (problems.length) {
      this.refuse(source, problems);
      return problems;
    }
    this.#declarations.set(declaration.id, declaration);
    this.#integrations.set(declaration.id, integration);
    return [];
  }

  /**
   * Accepts one protocol of an integration's with its code, if it keeps the
   * contract and is named as that integration's (`acme-cloud` is Acme's).
   * What installing an integration already imported does.
   */
  install(protocol: Protocol, integration: string, source = protocol.id): string[] {
    const problems = [...validateProtocol(protocol), ...this.#placeProblems(protocol.id, integration)];
    if (problems.length) {
      this.refuse(source, problems);
      return problems;
    }
    this.#declarations.set(protocol.id, protocolDeclarationOf(protocol));
    this.#integrations.set(protocol.id, integration);
    this.#protocols.set(protocol.id, protocol);
    return [];
  }

  /** A declared protocol's code, loaded with its integration, if it keeps the contract. */
  provide(protocol: Protocol, source = protocol.id): string[] {
    const problems = this.#declarations.has(protocol.id) ? validateProtocol(protocol) : [`${protocol.id} is in its integration's code but not in its catalogue: run npm run gen:devices`];
    if (problems.length) {
      this.refuse(source, problems);
      return problems;
    }
    this.#declarations.set(protocol.id, protocolDeclarationOf(protocol));
    this.#protocols.set(protocol.id, protocol);
    return [];
  }

  /** A protocol's declaration, by id; none for a way that has none, through a bridge. */
  get(id: string | undefined): ProtocolDeclaration | null {
    if (id === undefined) return null;
    return this.#declarations.get(id) ?? null;
  }

  /** A protocol's code, if its integration has loaded; null until then. */
  loaded(id: string | undefined): Protocol | null {
    if (id === undefined) return null;
    return this.#protocols.get(id) ?? null;
  }

  /** A protocol's code, its integration loaded first if it has not. */
  async load(id: string | undefined): Promise<Protocol | null> {
    if (id === undefined) return null;
    const integration = this.#integrations.get(id);
    if (integration && !this.#protocols.has(id)) await this.#loader(integration);
    return this.#protocols.get(id) ?? null;
  }

  /** The integration a protocol is part of: a way of reaching a device speaks only its own integration's. */
  integrationOf(id: string): string | null {
    return this.#integrations.get(id) ?? null;
  }

  /** Every installed protocol's declaration. */
  all(): ProtocolDeclaration[] {
    return [...this.#declarations.values()];
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
