import type { TransportDefinition, TransportFactory } from '@kraftverk/device-sdk';
import type { KraftverkApi } from '@kraftverk/api-contract';
import { createFollower, createHub, installedFrom, passphraseSealing, type Follower, type Hub, type Installed } from '@kraftverk/hub';
import { AuditLog, createSchema, NodeStore, prepareDatabase, SCHEMA, schemaStateOf, transportStore, type SecretsAtRest, type SqlDatabase } from '@kraftverk/store';

import { INTEGRATIONS, TRANSPORTS } from '../../generated/installed';
import { appHttp } from '../http';
import type { ThisNode } from '../node';


/*
  The app's home (docs/PLAN-SHARED-CORE.md, phase 6): the hub the server
  runs — or, with a server, what this app holds for it — made from what
  the app installed (its generated registry) and from what the place it
  runs gives it: a phone's SQLite in the app's own process, or a browser's
  in its worker. This is the part both places share; each puts its own
  pieces in (`open.ts`, `open.web.ts`).
*/

/** A database ready to keep a family in — or, given its schema, the device's accounts: one with this schema, or a new one given it. Another schema is never written over. */
export function readyDatabase(database: SqlDatabase, madeBy: string, schema = SCHEMA): SqlDatabase {
  prepareDatabase(database);
  const state = schemaStateOf(database, schema);
  if (state === 'empty') createSchema(database, madeBy, schema);
  else if (state === 'other') throw new Error('This database was made by another kraftverk: it is kept as it is, and a home is not opened in it');
  return database;
}

export type AppPlace = {
  /** The node this app is: the same id in its own home and in a server's. */
  node: ThisNode;
  database: SqlDatabase;
  secrets: SecretsAtRest;
  platform: 'web' | 'native';
  /** How each transport is made where the hub runs — its own entry, or one reaching the page — or null where it cannot run. */
  transport: (definition: TransportDefinition) => TransportFactory | null;
  /** Every write to hardware refused: an app's switch, off every launch. */
  readOnly: () => boolean;
};

const log = (level: 'info' | 'warn' | 'error', message: string) => console[level === 'info' ? 'log' : level](message);

/** What the app installed (its generated registry), with each transport made as this place makes it; what a transport records goes to `record`. */
function appInstalled(place: AppPlace, record: (entry: Parameters<AuditLog['record']>[0]) => void): Installed {
  return installedFrom(
    { integrations: INTEGRATIONS, transports: TRANSPORTS.map((definition) => ({ definition, create: place.transport(definition) })) },
    {
      platform: place.platform,
      context: { env: {}, log, audit: (entry) => record({ at: new Date().toISOString(), ...entry }) },
      store: (id) => transportStore(place.database, id),
    }
  );
}

/**
 * The node a database is kept by: the one it already says it is, when it
 * says — a database is one node's, for good — or this app's, the first time.
 */
function nodeFor(place: AppPlace): ThisNode {
  const own = new NodeStore(place.database).self();
  return own ? { ...place.node, id: own.id } : place.node;
}

/** An account's own family in this place, by its id: not started; `start()` it. `copy`: the copy it kept of the server it used last, to keep as this family. */
export function appHub(place: AppPlace & { familyId: string; copy?: SqlDatabase }): Hub {
  // Its timeline, made here so what a transport records goes on it too.
  const audit = new AuditLog(place.database);
  const installed = appInstalled(place, (entry) => audit.record(entry));
  return createHub({
    database: place.database,
    audit,
    secrets: place.secrets,
    sealing: passphraseSealing,
    installed,
    readOnly: place.readOnly,
    readOnlyReason: 'Writes from this app are off: allow them in App settings',
    // Frames nobody has described are for a server started to bring up a unit, never for an app.
    allowRawFrames: false,
    http: appHttp,
    node: nodeFor(place),
    log,
    familyId: place.familyId,
    ...(place.copy ? { copy: place.copy } : {}),
  });
}

/**
 * What this app holds for a server's home, in this place: the server's
 * `KraftverkApi` with this app's own ways wrapped in, kept in this app's
 * own database. Not started; `start()` it.
 */
export function appFollower(place: AppPlace & { home: KraftverkApi; own?: SqlDatabase }): Follower {
  // What a transport records is owed to the server's timeline, as the follower's own entries are.
  let follower: Follower | null = null;
  const installed = appInstalled(place, (entry) => follower?.owe('audit', null, entry));
  follower = createFollower({
    home: place.home,
    database: place.database,
    secrets: place.secrets,
    installed,
    node: nodeFor(place),
    readOnly: place.readOnly,
    readOnlyReason: 'Writes from this app are off: allow them in App settings',
    http: appHttp,
    log,
    // The home this app kept itself before, offered to the server.
    ...(place.own ? { own: { database: place.own, sealing: passphraseSealing } } : {}),
  });
  return follower;
}
