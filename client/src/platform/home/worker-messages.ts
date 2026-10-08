import type { NodeId } from '@kraftverk/device-sdk';

import type { ThisNode } from '../node';

/*
  What the page and a browser's kraftverk in its worker say to each other
  (`open.web.ts`, `worker.ts`): the device first — this browser's files,
  its accounts — then a family inside it. The accounts' interface, a
  family's, a server's, and the transports cross beside this, by
  `@kraftverk/message-port`.
*/

export type ToWorker =
  /** Hold this browser's files — asking the tab that has them to let go, with `takeOver` — and serve its accounts as `personal`. */
  | { via: 'home'; kind: 'start'; takeOver: boolean }
  | {
      via: 'home';
      kind: 'open';
      /** The transports the page runs for it, by id: the rest cannot run in a browser. */
      serves: string[];
      writes: boolean;
      /** The node this app is: its id, and what it is called in "held by …". */
      node: ThisNode;
      /** The account it is opened as. */
      person: { id: string; name: string };
      /** With a server: whose home this is — the page serves its interface as `server`. */
      server: { key: string } | null;
      /** Without a server: the account's own family, by its id. */
      family: { id: string } | null;
      /** Without a server: the server it used last, whose home it kept a copy of — offered to keep. */
      copyOf: string | null;
      /** With a server: the account's own family, offered to it. */
      own: { id: string } | null;
    }
  | { via: 'home'; kind: 'writes'; allowed: boolean }
  /** Let go of the family open now; the device stays. */
  | { via: 'home'; kind: 'close' };

export type ToPage =
  /** This browser's files are held: its accounts are served. */
  | { via: 'home'; kind: 'started' }
  /** Another tab holds this browser's files. */
  | { via: 'home'; kind: 'busy' }
  | { via: 'home'; kind: 'failed'; message: string }
  /** A family is open, as the node this app is. */
  | { via: 'home'; kind: 'ready'; nodeId: NodeId }
  /** The family was let go of, as asked. */
  | { via: 'home'; kind: 'closed' }
  /** Everything was let go of: another tab asked for this browser's files. */
  | { via: 'home'; kind: 'ended' };
