/**
 * One end of a message port: what a `MessagePort`, a `Worker` and a worker's
 * own global scope all are, as far as kraftverk carries anything over one.
 * Messages are structured clones — plain data, `Uint8Array`, `ArrayBuffer` —
 * never a function or a class.
 */
export type MessageEnd = {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  /** A `MessagePort` delivers nothing until started; the others start themselves. */
  start?(): void;
};

/** What every message here carries: which conversation it belongs to, so several can share one end. */
export type Tagged = { readonly via: string };

/**
 * Hears the messages on `end` that belong to `via`, and nothing else, until
 * the returned function is called.
 */
export function hear<M extends Tagged>(end: MessageEnd, via: string, handler: (message: M) => void): () => void {
  const listener = (event: { data: unknown }) => {
    const message = event.data as Partial<Tagged> | null;
    if (message && typeof message === 'object' && message.via === via) handler(message as M);
  };
  end.addEventListener('message', listener);
  end.start?.();
  return () => end.removeEventListener('message', listener);
}

/** A number for each thing asked or opened, unique on this side of one conversation. */
export const counter = () => {
  let next = 0;
  return () => ++next;
};

/** A refusal or a failure as it crosses: what the other side throws again. */
export type Failure = {
  name: string;
  message: string;
  /** An `ApiError`'s own: its kind, each problem, the token a yes is sent back with. */
  kind?: string;
  problems?: readonly string[];
  needsConfirmation?: string | null;
};

export const failureOf = (error: unknown): Failure => {
  if (!(error instanceof Error)) return { name: 'Error', message: String(error) };
  const own = error as Error & { kind?: unknown; problems?: unknown; needsConfirmation?: unknown };
  return {
    name: error.name,
    message: error.message,
    ...(typeof own.kind === 'string' ? { kind: own.kind } : {}),
    ...(Array.isArray(own.problems) ? { problems: own.problems.map(String) } : {}),
    ...(typeof own.needsConfirmation === 'string' ? { needsConfirmation: own.needsConfirmation } : {}),
  };
};
