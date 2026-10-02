import type { Caller, KraftverkApi } from '@kraftverk/api-contract';
import type { NodeId } from '@kraftverk/device-sdk';

import type { ThisNode } from '../node';

/*
  What the app opens where it runs, to the screens and to the place that
  opens it — and nothing that runs one, so a browser's page, whose home
  runs in its worker, carries none of the hub (docs/PLAN-SHARED-CORE.md,
  phase 6). Without a server, a home of the app's own; with one, the
  server's home with what this app holds for it wrapped in. Either way one
  interface.
*/

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
  /** Settles when it was let go of without being closed here: another tab of a browser asked for it. A phone's never does. */
  readonly ended: Promise<'handed-over'>;
};

export type OpenOptions = {
  /** In a browser: ask the tab that holds this browser's database to let go of it. */
  takeOver?: boolean;
  /**
   * The server whose home this is, asked over HTTP by the person signed in:
   * what this app holds for it is kept in a database of this app's own for
   * that server (`key`). Without one, the app keeps a home of its own.
   */
  server?: { key: string; api: KraftverkApi };
  /** The node this app is: its own id, and what it is called in "held by …" — "Chrome on Windows". */
  node: ThisNode;
  /**
   * Without a server: the server it used last (`key`), whose home it kept a
   * copy of — offered to keep as its own. With one, the home the app kept
   * itself before is offered to the server.
   */
  copyOf?: string | null;
};

/** This browser's database is held by another of its tabs: it can be asked to let go (`takeOver`). */
export class HomeOpenElsewhere extends Error {
  constructor() {
    super('This browser’s own home is open in another tab');
    this.name = 'HomeOpenElsewhere';
  }
}

/** Who asks a home the app keeps itself: its owner, the only one there is. */
export const OWNER: Caller = { kind: 'person', name: 'you' };

/** The file a home is kept in: one per schema, so a new one never writes over the last — and, with a server, one per server. */
export const databaseFile = (fingerprint: number, server?: string): string => `kraftverk-${fingerprint}${server ? `-${server.replace(/[^A-Za-z0-9_-]/g, '')}` : ''}.db`;
