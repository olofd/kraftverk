import type { Caller, KraftverkApi, PersonalApi } from '@kraftverk/api-contract';
import type { NodeId } from '@kraftverk/device-sdk';

import type { ThisNode } from '../node';

/*
  What the app opens where it runs, to the screens and to the place that
  opens it — and nothing that runs one, so a browser's page, whose home
  runs in its worker, carries none of the hub (docs/PLAN-SHARED-CORE.md,
  phase 6). First the device: the accounts on it and their keys
  (docs/PLAN-WORLD-MODEL.md §10.6). Then, inside it, a family: an account's
  own, kept here, or a server's with what this app holds for it wrapped in.
  Either way one interface.
*/

/** This device, opened: the accounts it keeps, and the families it opens for them. */
export type OpenDevice = {
  readonly personal: PersonalApi;
  /** A family, opened as one of this device's accounts; one at a time — opening another lets go of the last. */
  openHome(options: OpenOptions): Promise<OpenHome>;
  /** Lets go of everything: the family, the accounts, the device's files. */
  close(): Promise<void>;
  /** Settles when another tab of a browser asked for this device's files. A phone's never does. */
  readonly ended: Promise<'handed-over'>;
};

/** A home opened where the app runs: a phone's (`open.ts`), a browser's (`open.web.ts`). */
export type OpenHome = {
  /** Everything it answers: the app's own home, or the server's with what this app holds wrapped in. */
  readonly api: KraftverkApi;
  /** This app, as a node of the home: the id it is known by in its own home and in every server’s. */
  readonly nodeId: NodeId;
  /** Whether writes to hardware are allowed from here: refused every launch, until someone says. */
  allowWrites(allowed: boolean): Promise<void>;
  /** Stops it, and lets go of its database. */
  close(): Promise<void>;
};

export type OpenOptions = {
  /** Who asks it: the account opened as, by its person id. */
  person: { id: string; name: string };
  /**
   * The server whose home this is, asked over HTTP by the person signed in:
   * what this app holds for it is kept in a database of this app's own for
   * that server (`key`). Without one, the account's own family.
   */
  server?: { key: string; api: KraftverkApi };
  /** Without a server: the account's own family, by its id — its database is named by it. */
  family?: { id: string };
  /** The node this app is: its own id, and what it is called in "held by …" — "Chrome on Windows". */
  node: ThisNode;
  /**
   * Without a server: the server it used last (`key`), whose home it kept a
   * copy of — offered to keep as this family. With one, the account's own
   * family is offered to the server.
   */
  copyOf?: string | null;
  /** With a server: the account's own family, offered to it. */
  own?: { id: string } | null;
};

/** This browser's files are held by another of its tabs: it can be asked to let go (`takeOver`). */
export class HomeOpenElsewhere extends Error {
  constructor() {
    super('This browser’s kraftverk is open in another tab');
    this.name = 'HomeOpenElsewhere';
  }
}

/** Who asks a family this app keeps itself: the account opened as. */
export const callerOf = (person: OpenOptions['person']): Caller => ({ kind: 'person', id: person.id, name: person.name });

/** The file a family is kept in: one per schema, so a new one never writes over the last — and one per family, or per server. */
export const databaseFile = (fingerprint: number, of: string): string => `kraftverk-${fingerprint}-${of.replace(/[^A-Za-z0-9_-]/g, '')}.db`;

/** The file this device's accounts are kept in: one per schema of the personal store. */
export const personalFile = (fingerprint: number): string => `kraftverk-personal-${fingerprint}.db`;
