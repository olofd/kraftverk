import type { TransportDefinition, TransportFactory } from '@kraftverk/device-sdk';
import { createHub, installedFrom, type Hub } from '@kraftverk/hub';
import { AuditLog, createSchema, prepareDatabase, schemaStateOf, transportStore, type SecretsAtRest, type SqlDatabase } from '@kraftverk/store';

import { DEVICE_TYPES, PROTOCOLS, TRANSPORTS } from '../../generated/installed';
import { appSealing } from '../cipher';
import { appHttp } from '../http';

export { OWNER } from './home';

/*
  The app's own home (docs/PLAN-SHARED-CORE.md, phase 6): the hub the
  server runs, made from what the app installed (its generated registry)
  and from what the place it runs gives it — a phone's SQLite in the app's
  own process, or a browser's in its worker. This is the part both places
  share; each puts its own pieces in (`own.ts`, `own.web.ts`).
*/

/** A database ready to keep a home in: one with this schema, or a new one given it. Another schema is never written over. */
export function readyDatabase(database: SqlDatabase, madeBy: string): SqlDatabase {
  prepareDatabase(database);
  const state = schemaStateOf(database);
  if (state === 'empty') createSchema(database, madeBy);
  else if (state === 'other') throw new Error('This database was made by another kraftverk: it is kept as it is, and a home is not opened in it');
  return database;
}

export type AppPlace = {
  database: SqlDatabase;
  secrets: SecretsAtRest;
  platform: 'web' | 'native';
  /** How each transport is made where the hub runs — its own entry, or one reaching the page — or null where it cannot run. */
  transport: (definition: TransportDefinition) => TransportFactory | null;
  /** Every write to hardware refused: an app's switch, off every launch. */
  readOnly: () => boolean;
};

/** The app's home in this place: not started; `start()` it. */
export function appHub(place: AppPlace): Hub {
  const log = (level: 'info' | 'warn' | 'error', message: string) => console[level === 'info' ? 'log' : level](message);
  // Its timeline, made here so what a transport records goes on it too.
  const audit = new AuditLog(place.database);
  const installed = installedFrom(
    { types: DEVICE_TYPES, protocols: PROTOCOLS, transports: TRANSPORTS.map((definition) => ({ definition, create: place.transport(definition) })) },
    {
      platform: place.platform,
      context: { env: {}, log, audit: (entry) => audit.record({ at: new Date().toISOString(), ...entry }) },
      store: (id) => transportStore(place.database, id),
    }
  );
  return createHub({
    database: place.database,
    audit,
    secrets: place.secrets,
    sealing: appSealing,
    installed,
    readOnly: place.readOnly,
    // Frames nobody has described are for a server started to bring up a unit, never for an app.
    allowRawFrames: false,
    http: appHttp,
    owner: 'client',
    log,
  });
}
