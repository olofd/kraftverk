import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, resolve } from 'node:path';

import { isNodeId, newNodeId } from '@kraftverk/device-sdk';
import type { HubOptions } from '@kraftverk/hub';
import { NodeStore, type SqlDatabase } from '@kraftverk/store';

import { databaseFile } from './database.ts';

/**
 * The kraftverk node this server is (docs/DATA-MODEL.md §3): a machine that
 * runs while nobody looks, that others connect to, and that may keep what
 * must stay put.
 *
 * Its id is the node's own, not its database's: made the first time and kept
 * in a file beside the database, so a database set aside for a new schema is
 * followed by one that knows the same node, and every app that knew it still
 * does. A database that already says which node it is wins over the file —
 * the file lost, emptied or garbled is written again from it — so a start
 * never fails on it.
 *
 * Its name is the one it was first given: the machine's, unless that is a
 * container's made-up id, which would change with every deploy.
 */
export function thisNode(database: SqlDatabase, file = resolve(dirname(databaseFile()), 'node-id')): HubOptions['node'] {
  const kept = existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
  const own = new NodeStore(database).self();
  if (own && kept && own.id !== kept) console.warn(`[node] ${file} says ${kept}, the database says ${own.id}: the database's is kept`);
  const id = own?.id ?? (isNodeId(kept) ? kept : newNodeId());
  if (id !== kept) {
    // Written whole or not at all: a half-written id would be another node.
    writeFileSync(`${file}.new`, `${id}\n`);
    renameSync(`${file}.new`, file);
  }
  return { id, name: own?.name ?? machineName(), alwaysOn: true, reachable: true, trusted: true };
}

/** The machine's name, unless it is a container's id (twelve or more hex digits): then plainly "Server". */
function machineName(): string {
  const name = hostname();
  return name && !/^[0-9a-f]{12,}$/.test(name) ? name : 'Server';
}
