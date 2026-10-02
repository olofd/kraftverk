import { ApiError, type ApiErrorKind, type KraftverkApi, type LiveStream, type LiveUpdate, type ViewReport } from '@kraftverk/api-contract';

import { counter, failureOf, hear, type Failure, type MessageEnd } from './end.ts';

/*
  KraftverkApi over a message port (docs/PLAN-SHARED-CORE.md, phase 6): a
  home served on one side — a browser's worker, holding a hub — and the
  same interface on the other, where the screens are. Every call by its
  path and its arguments, its answer or its refusal back as the ApiError the
  hub threw; the live stream as a stream; a setup step's abort as an abort.
  Nothing here names a call: a call the interface gains crosses with no
  change, and one it does not have is refused on the serving side.
*/

type Call = { via: string; kind: 'call'; id: number; path: string[]; args: unknown[] };
type ToServer =
  | Call
  | { via: string; kind: 'abort'; signal: number }
  | { via: string; kind: 'live'; stream: number }
  | { via: string; kind: 'say'; stream: number; view: ViewReport }
  | { via: string; kind: 'close'; stream: number };
type ToClient =
  | { via: string; kind: 'answer'; id: number; value: unknown }
  | { via: string; kind: 'refused'; id: number; failure: Failure }
  | { via: string; kind: 'update'; stream: number; update: LiveUpdate };

/** Where an `AbortSignal` was in a call's arguments: a signal cannot cross, its abort can. */
type SignalMark = { readonly $signal: number };
const isSignalMark = (value: unknown): value is SignalMark => typeof value === 'object' && value !== null && typeof (value as SignalMark).$signal === 'number';
const isSignal = (value: unknown): value is AbortSignal =>
  typeof value === 'object' && value !== null && typeof (value as AbortSignal).aborted === 'boolean' && typeof (value as AbortSignal).addEventListener === 'function';

/** Names that are a JavaScript object's, never the interface's: not a way in. */
const NOT_CALLS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Serves `api` on `end`: every call that arrives is made on it, and its
 * answer sent back. Returns how to stop, which closes every live stream it
 * opened.
 */
export function serveApi(api: KraftverkApi, end: MessageEnd, via = 'api'): () => void {
  const streams = new Map<number, LiveStream>();
  const aborts = new Map<number, AbortController>();
  const send = (message: ToClient) => end.postMessage(message);

  /** The function a path names, on the object it belongs to — only the interface's own. */
  const resolve = (path: readonly string[]): { owner: object; fn: (...args: unknown[]) => unknown } | null => {
    let owner: unknown = null;
    let at: unknown = api;
    for (const key of path) {
      if (NOT_CALLS.has(key) || typeof at !== 'object' || at === null || !Object.prototype.hasOwnProperty.call(at, key)) return null;
      owner = at;
      at = (at as Record<string, unknown>)[key];
    }
    return typeof at === 'function' && owner ? { owner, fn: at as (...args: unknown[]) => unknown } : null;
  };

  const call = async (message: Call) => {
    const target = message.path[0] === 'live' ? null : resolve(message.path);
    const signals: number[] = [];
    try {
      if (!target) throw new ApiError('not-found', `A home has no "${message.path.join('.')}"`);
      const args = message.args.map((arg) => {
        if (!isSignalMark(arg)) return arg;
        const controller = new AbortController();
        aborts.set(arg.$signal, controller);
        signals.push(arg.$signal);
        return controller.signal;
      });
      send({ via, kind: 'answer', id: message.id, value: await target.fn.apply(target.owner, args) });
    } catch (error) {
      send({ via, kind: 'refused', id: message.id, failure: failureOf(error) });
    } finally {
      for (const signal of signals) aborts.delete(signal);
    }
  };

  const stop = hear<ToServer>(end, via, (message) => {
    switch (message.kind) {
      case 'call':
        void call(message);
        return;
      case 'abort':
        aborts.get(message.signal)?.abort();
        return;
      case 'live':
        streams.set(message.stream, api.live((update) => send({ via, kind: 'update', stream: message.stream, update })));
        return;
      case 'say':
        streams.get(message.stream)?.say(message.view);
        return;
      case 'close':
        streams.get(message.stream)?.close();
        streams.delete(message.stream);
        return;
    }
  });

  return () => {
    stop();
    for (const stream of streams.values()) stream.close();
    streams.clear();
    for (const controller of aborts.values()) controller.abort();
    aborts.clear();
  };
}

/** A failure that crossed, thrown again as what it was: a refusal in words, or an error. */
export function thrownAgain(failure: Failure): Error {
  if (failure.name === 'ApiError' && failure.kind) {
    return new ApiError(failure.kind as ApiErrorKind, failure.message, { problems: failure.problems ?? [], ...(failure.needsConfirmation ? { needsConfirmation: failure.needsConfirmation } : {}) });
  }
  const error = new Error(failure.message);
  error.name = failure.name;
  return error;
}

/**
 * The home served on the other end of `end`, as `KraftverkApi`: the same
 * interface the hub answers in the process and `httpApi` over HTTP.
 */
export function apiOver(end: MessageEnd, via = 'api'): KraftverkApi {
  const nextCall = counter();
  const nextSignal = counter();
  const nextStream = counter();
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const streams = new Map<number, (update: LiveUpdate) => void>();
  const send = (message: ToServer) => end.postMessage(message);

  hear<ToClient>(end, via, (message) => {
    if (message.kind === 'update') return streams.get(message.stream)?.(message.update);
    const waiting = pending.get(message.id);
    if (!waiting) return;
    pending.delete(message.id);
    if (message.kind === 'answer') waiting.resolve(message.value);
    else waiting.reject(thrownAgain(message.failure));
  });

  const call = (path: string[], args: unknown[]) =>
    new Promise<unknown>((resolve, reject) => {
      const id = nextCall();
      const cleanups: (() => void)[] = [];
      const crossing = args.map((arg) => {
        if (!isSignal(arg)) return arg;
        const signal = nextSignal();
        const abort = () => send({ via, kind: 'abort', signal });
        if (arg.aborted) queueMicrotask(abort);
        else {
          arg.addEventListener('abort', abort, { once: true });
          cleanups.push(() => arg.removeEventListener('abort', abort));
        }
        return { $signal: signal } satisfies SignalMark;
      });
      const done = () => cleanups.forEach((cleanup) => cleanup());
      pending.set(id, {
        resolve: (value) => {
          done();
          resolve(value);
        },
        reject: (error) => {
          done();
          reject(error);
        },
      });
      send({ via, kind: 'call', id, path, args: crossing });
    });

  const live = (listener: (update: LiveUpdate) => void): LiveStream => {
    const stream = nextStream();
    streams.set(stream, listener);
    send({ via, kind: 'live', stream });
    return {
      say: (view) => send({ via, kind: 'say', stream, view }),
      close: () => {
        if (!streams.delete(stream)) return;
        send({ via, kind: 'close', stream });
      },
    };
  };

  /**
   * Each name a further step of the path; calling it, the call. Not a
   * promise, so awaiting it is not a call; and one part, the same each time
   * it is named, as a part of an object is.
   */
  const parts = new Map<string, unknown>();
  const node = (path: string[]): unknown => {
    const key = path.join('.');
    if (!parts.has(key)) parts.set(key, part(path));
    return parts.get(key);
  };
  const part = (path: string[]): unknown =>
    new Proxy(function interfacePart() {}, {
      get: (_target, key) => {
        if (typeof key === 'symbol' || key === 'then') return undefined;
        if (path.length === 0 && key === 'live') return live;
        return node([...path, key]);
      },
      apply: (_target, _this, args: unknown[]) => call(path, args),
    });

  return node([]) as KraftverkApi;
}
