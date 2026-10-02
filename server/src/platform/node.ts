import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, resolve } from 'node:path';

import { newNodeId, nodeId } from '@kraftverk/device-sdk';
import type { HubOptions } from '@kraftverk/hub';

import { databaseFile } from './database.ts';

/**
 * The kraftverk node this server is (docs/DATA-MODEL.md §3): a machine that
 * runs while nobody looks, that others connect to, and that may keep what
 * must stay put.
 *
 * Its id is the node's own, not its database's: made the first time and kept
 * in a file beside the database, so a database set aside for a new schema is
 * followed by one that knows the same node, and every app that knew it still
 * does. Its name is the machine's, until the home calls it something else.
 */
export function thisNode(): HubOptions['node'] {
  const file = resolve(dirname(databaseFile()), 'node-id');
  const kept = existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
  const id = kept ? nodeId(kept) : newNodeId();
  if (!kept) writeFileSync(file, `${id}\n`);
  return { id, name: hostname() || 'This machine', alwaysOn: true, reachable: true, trusted: true };
}
