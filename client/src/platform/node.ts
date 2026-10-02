import { newNodeId, nodeId, type NodeId } from '@kraftverk/device-sdk';

import { appName } from './here';
import { readPreference, writePreference } from './preferences';

/**
 * The kraftverk node this app is (docs/DATA-MODEL.md §3): one that runs
 * while someone looks, that nothing connects to, and that keeps nothing that
 * must stay put. With no server, its home's master; with one, a node that
 * follows it and holds the ways it reaches.
 *
 * Its id is the app's own, made the first time and kept with its
 * preferences: the same in its own home's database and in every server's it
 * joins, and kept when a database is set aside for a new schema.
 */
export type ThisNode = { id: NodeId; name: string; alwaysOn: boolean; reachable: boolean; trusted: boolean };

const KEY = 'kraftverk.node.id';

export function thisNode(): ThisNode {
  const kept = readPreference(KEY);
  const id = kept ? nodeId(kept) : newNodeId();
  if (!kept) writePreference(KEY, id);
  return { id, name: appName(), alwaysOn: false, reachable: false, trusted: false };
}
