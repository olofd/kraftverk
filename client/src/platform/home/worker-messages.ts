/*
  What the page and a browser's home in its worker say to each other about
  the home itself (`open.web.ts`, `worker.ts`); the home's interface, a
  server's, and the transports cross beside this, by
  `@kraftverk/message-port`.
*/

export type ToWorker =
  | {
      via: 'home';
      kind: 'open';
      /** The transports the page runs for it, by id: the rest cannot run in a browser. */
      serves: string[];
      /** Ask the tab that holds this browser's database to let go of it, and wait for it. */
      takeOver: boolean;
      writes: boolean;
      /**
       * With a server: whose home this is — the page serves its interface as
       * `server` — and what this app is called in "held by …". Without one,
       * the browser keeps a home of its own.
       */
      server: { key: string; name: string } | null;
    }
  | { via: 'home'; kind: 'writes'; allowed: boolean }
  | { via: 'home'; kind: 'close' };

export type ToPage =
  /** Open: with a server, this app as the server knows it. */
  | { via: 'home'; kind: 'ready'; appId: string | null }
  /** Another tab holds this browser's database. */
  | { via: 'home'; kind: 'busy' }
  | { via: 'home'; kind: 'failed'; message: string }
  /** Let go of: another tab asked for it, or this one closed it. */
  | { via: 'home'; kind: 'closed'; why: 'handed-over' | 'asked' };
