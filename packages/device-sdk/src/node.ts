import type { ConnectionMethod } from './connection.ts';
import { newId, ULID, type Branded } from './ids.ts';

/*
  A kraftverk node: the hub running somewhere — a machine on the network, a
  phone, a browser — what it runs on, what it declares it is, and its id,
  made by the node itself and the same in every home it joins.
*/

/**
 * The runtime a transport implementation is written for: what a kraftverk
 * node runs on.
 *
 * - `system` — a process on a machine, under Bun.
 * - `web` — a browser's page.
 * - `native` — a phone.
 *
 * A connection method never says where it runs: that follows from which of
 * these have an implementation of its transport, what it needs of the node
 * that holds it (`needs`), and whether that one is available right now.
 */
export type Platform = 'system' | 'web' | 'native';

export const PLATFORMS: readonly Platform[] = ['system', 'web', 'native'];

/**
 * What a kraftverk node declares it is (docs/DATA-MODEL.md §3): what tells
 * nodes apart, what a method may need of the node holding it, and how the
 * home's master is chosen. Never which kind of machine it is.
 */
export type NodeTraits = {
  /** It runs while nobody looks: it keeps history and runs automations at night. */
  alwaysOn: boolean;
  /** Others connect to it: it serves the home's interface. */
  reachable: boolean;
  /** What must stay put — a vendor account's password — may be kept on it. */
  trusted: boolean;
};

export const NODE_TRAITS: readonly (keyof NodeTraits)[] = ['alwaysOn', 'reachable', 'trusted'];

/** What a method needs of the node that holds it, each with why: `{ trusted: 'your account password stays at home' }`. */
export type NodeNeeds = { readonly [trait in keyof NodeTraits]?: string };

/** The first thing a method needs of the node holding it that the node is not, and why; null when it is all of them. */
export function unmetNeed(method: Pick<ConnectionMethod, 'needs'>, node: NodeTraits): { trait: keyof NodeTraits; why: string } | null {
  for (const trait of NODE_TRAITS) {
    const why = method.needs?.[trait];
    if (why !== undefined && !node[trait]) return { trait, why };
  }
  return null;
}

/** A kraftverk node — the hub running somewhere, holding connections: a row of `node`, the same id in every home that knows it. */
export type NodeId = Branded<'NodeId'>;

export const nodeId = (raw: string): NodeId => raw as NodeId;

/** What a node's id looks like: `n-` and a ULID. */
export const NODE_ID = new RegExp(`^n-${ULID}$`);

/** Whether text is a node's id, as a node makes one: what is kept where it runs, or sent by one joining, is checked by this. */
export const isNodeId = (raw: string): raw is NodeId => NODE_ID.test(raw);

/** A new node's id, made once by the node itself and kept where it runs. */
export const newNodeId = (): NodeId => nodeId(newId('n'));
