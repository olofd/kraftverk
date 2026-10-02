/*
  The globals every place kraftverk runs has — the server (Bun), a browser, a
  phone (Hermes) — and nothing more. Shared code is typechecked against this
  alone (`tsconfig.shared.json` in each shared package; docs/PLAN-SHARED-CORE.md),
  so a Node or Bun built-in, `process`, `Buffer`, `window` or `document`
  fails where it is written. Adding a name here is a decision: it must exist
  in all three places.

  Only declared as far as kraftverk uses it; each is a subset of the real
  thing, so code that typechecks here typechecks against Bun's and the DOM's.
*/

/** A timer's handle: only ever given back to clear it. */
interface KraftverkTimer {
  readonly __timer?: never;
}
declare function setTimeout(handler: (...args: never[]) => void, ms?: number): KraftverkTimer;
declare function clearTimeout(timer: KraftverkTimer | number | undefined | null): void;
declare function setInterval(handler: (...args: never[]) => void, ms?: number): KraftverkTimer;
declare function clearInterval(timer: KraftverkTimer | number | undefined | null): void;
declare function queueMicrotask(callback: () => void): void;

declare var console: {
  log(...data: unknown[]): void;
  info(...data: unknown[]): void;
  warn(...data: unknown[]): void;
  error(...data: unknown[]): void;
  debug(...data: unknown[]): void;
};

declare class TextEncoder {
  encode(input?: string): Uint8Array;
}
declare class TextDecoder {
  constructor(label?: string, options?: { fatal?: boolean });
  decode(input?: ArrayBufferView | ArrayBuffer): string;
}

/** Base64 of a string of bytes, and back: React Native has them since 0.74. */
declare function btoa(data: string): string;
declare function atob(data: string): string;

/** Random values only: `randomUUID` and `subtle` are not on a phone. */
declare var crypto: {
  getRandomValues<T extends ArrayBufferView | null>(array: T): T;
};

interface AbortSignal {
  readonly aborted: boolean;
  readonly reason: unknown;
  addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: 'abort', listener: () => void): void;
  throwIfAborted(): void;
}
declare var AbortSignal: {
  prototype: AbortSignal;
  timeout(ms: number): AbortSignal;
  any(signals: AbortSignal[]): AbortSignal;
};
declare class AbortController {
  readonly signal: AbortSignal;
  abort(reason?: unknown): void;
}

declare class URL {
  constructor(url: string, base?: string | URL);
  href: string;
  protocol: string;
  host: string;
  hostname: string;
  port: string;
  pathname: string;
  search: string;
  hash: string;
  readonly origin: string;
  readonly searchParams: URLSearchParams;
  toString(): string;
}
declare class URLSearchParams {
  constructor(init?: string | Record<string, string> | [string, string][]);
  get(name: string): string | null;
  set(name: string, value: string): void;
  append(name: string, value: string): void;
  has(name: string): boolean;
  toString(): string;
}

interface Headers {
  get(name: string): string | null;
  has(name: string): boolean;
  set(name: string, value: string): void;
  forEach(callback: (value: string, name: string) => void): void;
}
type HeadersInit = Headers | Record<string, string> | [string, string][];
type BodyInit = string | ArrayBuffer | ArrayBufferView | URLSearchParams;
interface RequestInit {
  method?: string;
  headers?: HeadersInit;
  body?: BodyInit | null;
  signal?: AbortSignal | null;
  redirect?: 'follow' | 'error' | 'manual';
}
interface Response {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  readonly headers: Headers;
  readonly url: string;
  json(): Promise<unknown>;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}
