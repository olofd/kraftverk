import type { NodeId } from '@kraftverk/device-sdk';

import type { ThisNode } from '../node';

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
      /** The node this app is: its id, and what it is called in "held by …". */
      node: ThisNode;
      /**
       * With a server: whose home this is — the page serves its interface as
       * `server`. Without one, the browser keeps a home of its own.
       */
      server: { key: string } | null;
      /** Without a server: the server it used last, whose home it kept a copy of — offered to keep. */
      copyOf: string | null;
    }
  | { via: 'home'; kind: 'writes'; allowed: boolean }
  | { via: 'home'; kind: 'close' };

export type ToPage =
  /** Open, as the node this app is. */
  | { via: 'home'; kind: 'ready'; nodeId: NodeId }
  /** Another tab holds this browser's database. */
  | { via: 'home'; kind: 'busy' }
  | { via: 'home'; kind: 'failed'; message: string }
  /** Let go of: another tab asked for it, or this one closed it. */
  | { via: 'home'; kind: 'closed'; why: 'handed-over' | 'asked' };
