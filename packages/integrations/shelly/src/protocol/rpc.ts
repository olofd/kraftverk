import { hexOf, NeedsSignIn, randomHex, sha256, type ByteChannel } from '@kraftverk/device-sdk';

import { WebSocketOver } from './websocket.ts';

/*
  Shelly's RPC (Gen2 and later), as aioshelly speaks it over its WebSocket
  at /rpc: a request is {id, src, method, params}, answered by
  {id, result} or {id, error}; a device tells every client that has asked it
  something of each change, unasked, as NotifyStatus (what changed),
  NotifyFullStatus (all of it) and NotifyEvent (a button, a reboot).

  A device with a password answers 401, with a challenge in the error's
  message; every request then carries an `auth` object: SHA-256 digest of
  the user "admin", the device's realm and the password — RFC 7616 as
  Shelly applies it, with "dummy_method:dummy_uri" for the part HTTP would
  hash its method and URI into.
*/

/** How long an answer is waited for. */
const ANSWER_MS = 10_000;
/** How long a request waits for the connection to open. */
const OPEN_MS = 10_000;
/** The user a Shelly signs in: always admin. */
const USER = 'admin';

/** A challenge, as a 401 carries it in its message. */
type Challenge = { realm: string; nonce: number; algorithm: string };

/** An error the device answered with: its code and words. */
export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string
  ) {
    super(message);
  }
}

/** What a device tells of itself unasked: a change, everything, or an event. */
export type Notification = { method: 'NotifyStatus' | 'NotifyFullStatus' | 'NotifyEvent' | (string & {}); params: Record<string, unknown> };

type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };

/** The digest a request is signed with, for a challenge and a password. */
export function authOf(challenge: Challenge, password: string, cnonce: number = Number.parseInt(randomHex(4), 16)): Record<string, unknown> {
  const ha1 = hexOf(sha256(`${USER}:${challenge.realm}:${password}`));
  const ha2 = hexOf(sha256('dummy_method:dummy_uri'));
  const response = hexOf(sha256(`${ha1}:${challenge.nonce}:1:${cnonce}:auth:${ha2}`));
  return { realm: challenge.realm, username: USER, nonce: challenge.nonce, cnonce, response, algorithm: 'SHA-256' };
}

/** One device's RPC, over the byte channel the home network's transport opened to it. */
export class ShellyRpc {
  #socket: WebSocketOver;
  #next = 1;
  #pending = new Map<number, Pending>();
  #challenge: Challenge | null = null;
  /** Who this side is to the device: what it answers to, and tells of changes. */
  #src = `kraftverk-${randomHex(4)}`;

  constructor(
    channel: ByteChannel,
    private options: { host: string; password: () => string | null; onNotification?(notification: Notification): void; onOpen?(open: boolean): void }
  ) {
    this.#socket = new WebSocketOver(channel, {
      path: '/rpc',
      host: options.host,
      onMessage: (text) => this.#heard(text),
      onOpen: (open) => {
        if (!open) for (const [id, pending] of this.#pending) this.#settle(id, pending, new Error('The connection to the device dropped'));
        options.onOpen?.(open);
      },
    });
  }

  get open(): boolean {
    return this.#socket.open;
  }

  /**
   * Calls one method and answers its result. Signed when the device asked for
   * it; a device that refuses the password, or asks for one none was given,
   * throws `NeedsSignIn`.
   */
  async call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    try {
      return await this.#request<T>(method, params);
    } catch (error) {
      if (!(error instanceof RpcError) || error.code !== 401) throw error;
      // Asked to sign in: the challenge is in the words.
      this.#challenge = challengeOf(error.message);
      if (!this.#challenge) throw error;
      if (!this.options.password()) throw new NeedsSignIn('The device has a password: give it on its connection');
      try {
        return await this.#request<T>(method, params);
      } catch (again) {
        if (again instanceof RpcError && again.code === 401) throw new NeedsSignIn('The device did not accept that password: give it again on its connection');
        throw again;
      }
    }
  }

  async close(): Promise<void> {
    for (const [id, pending] of this.#pending) this.#settle(id, pending, new Error('Closed'));
    await this.#socket.close();
  }

  async #request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    if (!(await this.#socket.opened(OPEN_MS))) throw new Error('The device did not answer on the home network');
    const id = this.#next++;
    const password = this.options.password();
    const message = { id, src: this.#src, method, params, ...(this.#challenge && password ? { auth: authOf(this.#challenge, password) } : {}) };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => this.#settle(id, this.#pending.get(id)!, new Error(`The device did not answer ${method}`)), ANSWER_MS);
      this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.#socket.send(JSON.stringify(message)).catch((error: Error) => this.#settle(id, this.#pending.get(id)!, error));
    });
  }

  #settle(id: number, pending: Pending | undefined, error: Error | null, value?: unknown): void {
    if (!pending) return;
    clearTimeout(pending.timer);
    this.#pending.delete(id);
    if (error) pending.reject(error);
    else pending.resolve(value);
  }

  #heard(text: string): void {
    let message: { id?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown }; method?: unknown; params?: unknown };
    try {
      message = JSON.parse(text) as typeof message;
    } catch {
      return;
    }
    if (typeof message.id === 'number' && this.#pending.has(message.id)) {
      const pending = this.#pending.get(message.id);
      if (message.error) this.#settle(message.id, pending, new RpcError(Number(message.error.code), String(message.error.message ?? 'The device refused')));
      else this.#settle(message.id, pending, null, message.result);
      return;
    }
    if (typeof message.method === 'string' && message.params && typeof message.params === 'object') {
      this.options.onNotification?.({ method: message.method, params: message.params as Record<string, unknown> });
    }
  }
}

/** The challenge a 401 carries in its message, as JSON; null when it carries none. */
function challengeOf(message: string): Challenge | null {
  try {
    const said = JSON.parse(message) as Partial<Challenge>;
    return typeof said.realm === 'string' && typeof said.nonce === 'number' ? { realm: said.realm, nonce: said.nonce, algorithm: said.algorithm ?? 'SHA-256' } : null;
  } catch {
    return null;
  }
}
