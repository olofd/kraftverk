import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NODE_ID, nodeId } from '@kraftverk/device-sdk';
import { NodeStore } from '@kraftverk/store';

import { openSchema } from './database.ts';
import { thisNode } from './node.ts';

/*
  The node this server is: its id kept beside its database, and never a
  reason for a start to fail — a file lost, emptied or garbled is written
  again, and a database that says which node it is wins. These use their own
  files: nothing here touches the shared database.
*/

const dirs: string[] = [];
const place = () => {
  const dir = mkdtempSync(join(tmpdir(), 'kraftverk-node-'));
  dirs.push(dir);
  return { database: openSchema(join(dir, 'kraftverk.db')), file: join(dir, 'node-id') };
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('the node this server is', () => {
  test('made the first time, kept in its file, and the same at the next start', () => {
    const { database, file } = place();
    const first = thisNode(database, file);
    expect(first.id).toMatch(NODE_ID);
    expect(readFileSync(file, 'utf8').trim()).toBe(first.id);
    expect(first).toMatchObject({ alwaysOn: true, reachable: true, trusted: true });
    expect(thisNode(database, file).id).toBe(first.id);
    database.close();
  });

  test('a garbled file is made again; a database that knows its node wins over any file, and keeps its name', () => {
    const { database, file } = place();
    writeFileSync(file, 'not an id\n');
    expect(thisNode(database, file).id).toMatch(NODE_ID);

    new NodeStore(database).declareSelf({ id: nodeId('n-000000000000000000000000A1'), name: 'Garage machine', platform: 'system', transports: [], alwaysOn: true, reachable: true, trusted: true });
    writeFileSync(file, 'n-000000000000000000000000FF\n');
    expect(thisNode(database, file)).toMatchObject({ id: 'n-000000000000000000000000A1', name: 'Garage machine' });
    expect(readFileSync(file, 'utf8').trim()).toBe('n-000000000000000000000000A1');
    database.close();
  });
});
