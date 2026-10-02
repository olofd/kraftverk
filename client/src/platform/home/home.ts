import type { Caller, KraftverkApi } from '@kraftverk/api-contract';

/*
  What a home the app keeps itself is, to the screens and to the place that
  opens it — and nothing that runs one, so the page of a browser, whose
  home runs in its worker, carries none of the hub.
*/

/** A home the app keeps itself, open where the app runs: a phone's (`own.ts`), a browser's (`own.web.ts`). */
export type OwnHome = {
  /** Everything it answers, for its owner: the interface a server's home answers too. */
  readonly api: KraftverkApi;
  /** Whether writes to hardware are allowed from here: refused every launch, until its owner says. */
  allowWrites(allowed: boolean): Promise<void>;
  /** Stops it, and lets go of its database. */
  close(): Promise<void>;
  /** Settles when it was let go of without being closed here: another tab of a browser asked for it. A phone's never does. */
  readonly ended: Promise<'handed-over'>;
};

/** Opening a home the app keeps itself: in a browser, taking it over from the tab that holds it. */
export type OpenOptions = { takeOver?: boolean };

/** A browser's home is held by another of its tabs: it can be asked to let go (`takeOver`). */
export class HomeOpenElsewhere extends Error {
  constructor() {
    super('This home is open in another tab of this browser');
    this.name = 'HomeOpenElsewhere';
  }
}

/** Who asks a home the app keeps itself: its owner, the only one there is. */
export const OWNER: Caller = { kind: 'person', name: 'you' };
