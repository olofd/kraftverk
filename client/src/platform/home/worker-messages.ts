/*
  What the page and a browser's home in its worker say to each other about
  the home itself (`own.web.ts`, `worker.ts`); the home's interface and its
  transports cross beside this, by `@kraftverk/message-port`.
*/

export type ToWorker =
  | {
      via: 'home';
      kind: 'open';
      /** The transports the page runs for it, by id: the rest cannot run in a browser. */
      serves: string[];
      /** Ask the tab that holds the home to let go of it, and wait for it. */
      takeOver: boolean;
      writes: boolean;
    }
  | { via: 'home'; kind: 'writes'; allowed: boolean }
  | { via: 'home'; kind: 'close' };

export type ToPage =
  | { via: 'home'; kind: 'ready' }
  /** Another tab holds the home. */
  | { via: 'home'; kind: 'busy' }
  | { via: 'home'; kind: 'failed'; message: string }
  /** Let go of: another tab asked for it, or this one closed it. */
  | { via: 'home'; kind: 'closed'; why: 'handed-over' | 'asked' };
