import type { ByteChannel } from '@kraftverk/device-sdk';

import { FrameType, Framer, type Frame } from './frames.ts';
import { pack, unpack, type Opack } from './opack.ts';
import { PairingRefused, PairSetup, PairVerify, type Credentials } from './pairing.ts';

/*
  A Companion connection to an Apple TV, as pyatv's companion protocol
  speaks it (MIT; NOTICE): pairing frames first — pair-setup once, with the
  PIN; pair-verify on every connection — then OPACK messages, sealed, each
  an event (`_t` 1), a request (2) or a response (3) to one by its `_x`.
  Pure: over the TCP channel the home network's transport opened.
*/

/** A message as Companion carries it, read. */
export type Message = { readonly [key: string]: Opack };

/** What a request is answered with, when it takes too long. */
export const REQUEST_TIMEOUT_MS = 5_000;

const MESSAGE = { event: 1, request: 2, response: 3 } as const;

/** The TV answered a request with an error, or not at all. */
export class CompanionError extends Error {}

type Pending = { resolve(value: Message): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };

const isMessage = (value: Opack): value is Message => !!value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Uint8Array);

/** One connection: its frames, its pairing, and its messages. */
export class CompanionLink {
  #framer = new Framer();
  #auth: { answer: number; pending: Pending } | null = null;
  #requests = new Map<number, Pending>();
  #events = new Map<string, Set<(content: Message) => void>>();
  #xid = Math.floor(Math.random() * 0x10000);
  #stops: (() => void)[] = [];
  #closed = false;

  constructor(
    private channel: ByteChannel,
    private timeoutMs = REQUEST_TIMEOUT_MS,
  ) {
    this.#stops.push(channel.onData((bytes) => this.#receive(bytes)));
    this.#stops.push(
      channel.onConnectedChange((connected) => {
        if (connected) return;
        // Its keys were this connection's: the next one is verified afresh.
        this.#framer = new Framer();
        this.#failAll(new CompanionError('The TV closed the connection'));
      }),
    );
  }

  get verified(): boolean {
    return this.#framer.encrypted;
  }

  /** Lets go of the TV. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const stop of this.#stops) stop();
    this.#failAll(new CompanionError('The connection was closed'));
    await this.channel.close();
  }

  // --- pairing ---------------------------------------------------------------

  /** Asks the TV to start pairing: it shows a PIN. What it answered is the next turn's. */
  async startPairing(setup: PairSetup): Promise<Uint8Array> {
    return this.#pairingFrame(FrameType.PairSetupStart, FrameType.PairSetupNext, { _pd: setup.start(), _pwTy: 1 });
  }

  /** With the PIN the TV shows: the rest of pair-setup, and the credentials it leaves. */
  async finishPairing(setup: PairSetup, started: Uint8Array, pin: string, name: string): Promise<Credentials> {
    const proved = await this.#pairingFrame(FrameType.PairSetupNext, FrameType.PairSetupNext, { _pd: setup.proof(started, pin), _pwTy: 1 });
    const exchanged = await this.#pairingFrame(FrameType.PairSetupNext, FrameType.PairSetupNext, { _pd: setup.exchange(proved, name), _pwTy: 1 });
    return setup.finish(exchanged);
  }

  /** Pair-verify with the credentials a pairing left: every message after is sealed. */
  async verify(credentials: Credentials): Promise<void> {
    const verify = new PairVerify(credentials);
    const answered = await this.#pairingFrame(FrameType.PairVerifyStart, FrameType.PairVerifyNext, { _pd: verify.start(), _auTy: 4 });
    const finished = await this.#pairingFrame(FrameType.PairVerifyNext, FrameType.PairVerifyNext, { _pd: verify.answer(answered) });
    this.#framer.encrypt(verify.finish(finished, '', 'ClientEncrypt-main', 'ServerEncrypt-main'));
  }

  /** Whether the TV is reachable now: the connection is made in the background, and made again after it drops. */
  get connected(): boolean {
    return this.channel.connected;
  }

  /** Resolves once the connection is made; fails when it is not, in the time a request has. */
  async #ready(): Promise<void> {
    if (this.channel.connected) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        stop();
        reject(new CompanionError('The TV did not answer: is it on, and on this network?'));
      }, this.timeoutMs);
      const stop = this.channel.onConnectedChange((connected) => {
        if (!connected) return;
        clearTimeout(timer);
        stop();
        resolve();
      });
    });
  }

  async #pairingFrame(type: number, answer: number, content: Message): Promise<Uint8Array> {
    if (this.#auth) throw new CompanionError('A pairing step is already waiting for the TV');
    await this.#ready();
    const reply = await new Promise<Message>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#auth = null;
        reject(new CompanionError('The TV did not answer: is it on, and on this network?'));
      }, this.timeoutMs);
      this.#auth = { answer, pending: { resolve, reject, timer } };
      this.#write(type, pack(content)).catch((error: Error) => {
        clearTimeout(timer);
        this.#auth = null;
        reject(error);
      });
    });
    const data = reply._pd;
    if (!(data instanceof Uint8Array)) throw new PairingRefused('The TV answered pairing with nothing to read');
    return data;
  }

  // --- messages ----------------------------------------------------------------

  /** A request, and what the TV answers it with. */
  async request(id: string, content: Message = {}): Promise<Message> {
    const xid = this.#xid++ & 0xffffffff;
    const reply = new Promise<Message>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#requests.delete(xid);
        reject(new CompanionError(`The TV did not answer ${id}`));
      }, this.timeoutMs);
      this.#requests.set(xid, { resolve, reject, timer });
    });
    await this.#send({ _i: id, _x: xid, _t: MESSAGE.request, _c: content }).catch((error: Error) => {
      const pending = this.#requests.get(xid);
      if (pending) {
        clearTimeout(pending.timer);
        this.#requests.delete(xid);
        pending.reject(error);
      }
    });
    return reply;
  }

  /** An event: told, not answered. */
  async event(id: string, content: Message = {}): Promise<void> {
    await this.#send({ _i: id, _x: this.#xid++ & 0xffffffff, _t: MESSAGE.event, _c: content });
  }

  /** Listens for an event by its id. Returns how to stop. */
  onEvent(id: string, listener: (content: Message) => void): () => void {
    const listeners = this.#events.get(id) ?? new Set();
    listeners.add(listener);
    this.#events.set(id, listeners);
    return () => listeners.delete(listener);
  }

  async #send(message: Message): Promise<void> {
    if (!this.#framer.encrypted) throw new CompanionError('Not verified yet: pair-verify comes first');
    await this.#write(FrameType.SealedOpack, pack(message));
  }

  async #write(type: number, payload: Uint8Array): Promise<void> {
    if (this.#closed) throw new CompanionError('The connection was closed');
    await this.channel.write(this.#framer.write(type, payload));
  }

  // --- what arrives --------------------------------------------------------------

  #receive(bytes: Uint8Array): void {
    let frames: Frame[];
    try {
      frames = this.#framer.read(bytes);
    } catch (error) {
      this.#failAll(error as Error);
      void this.close();
      return;
    }
    for (const frame of frames) this.#frame(frame);
  }

  #frame(frame: Frame): void {
    if (frame.type === FrameType.NoOp || frame.payload.length === 0) return;
    let content: Opack;
    try {
      content = unpack(frame.payload).value;
    } catch {
      return;
    }
    if (!isMessage(content)) return;
    if (frame.type >= FrameType.PairSetupStart && frame.type <= FrameType.PairVerifyNext) {
      const auth = this.#auth;
      if (auth && auth.answer === frame.type) {
        this.#auth = null;
        clearTimeout(auth.pending.timer);
        auth.pending.resolve(content);
      }
      return;
    }
    if (frame.type !== FrameType.SealedOpack && frame.type !== FrameType.PlainOpack) return;
    const kind = content._t;
    if (kind === MESSAGE.response && typeof content._x === 'number') {
      const pending = this.#requests.get(content._x);
      if (!pending) return;
      this.#requests.delete(content._x);
      clearTimeout(pending.timer);
      const error = content._em ?? content._ec;
      if (error !== undefined && error !== null) pending.reject(new CompanionError(`The TV refused: ${String(error)}`));
      else pending.resolve(isMessage(content._c ?? null) ? (content._c as Message) : {});
      return;
    }
    if (kind === MESSAGE.event && typeof content._i === 'string') {
      const body = isMessage(content._c ?? null) ? (content._c as Message) : {};
      for (const listener of this.#events.get(content._i) ?? []) listener(body);
    }
  }

  #failAll(error: Error): void {
    if (this.#auth) {
      clearTimeout(this.#auth.pending.timer);
      this.#auth.pending.reject(error);
      this.#auth = null;
    }
    for (const pending of this.#requests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#requests.clear();
  }
}
