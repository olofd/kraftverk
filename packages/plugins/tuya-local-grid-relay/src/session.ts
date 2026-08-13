import { randomBytes } from 'node:crypto';
import { Socket } from 'node:net';

import { aesEcbEncrypt, aesGcmEncrypt, hmacSha256 } from './crypto.ts';
import {
  CMD,
  encodeFrame,
  FrameReader,
  type ProtocolVersion,
  type TuyaFrame,
} from './frame.ts';

/**
 * One TCP conversation with a Tuya device.
 *
 * 3.3 needs no handshake: every frame is AES-ECB with the local key. 3.4 and
 * 3.5 negotiate a session key first, and the connection must then be held open,
 * because dropping it throws the session away.
 *
 * Everything here follows the published protocol description in tinytuya's
 * PROTOCOL.md. The 3.4/3.5 negotiation in particular is implemented from that
 * document — see `docs/PLUGIN-ARCHITECTURE.md` §11.1.
 */

const PORT = 6668;
const CONNECT_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 5_000;
const HEARTBEAT_MS = 15_000;

export type SessionOptions = {
  host: string;
  deviceId: string;
  localKey: string;
  /**
   * `auto` tries each version until one answers, which is usually the right
   * setting: the version is a property of the firmware, people rarely know it,
   * and getting it wrong looks identical to a wrong key.
   */
  version: ProtocolVersion | 'auto';
  log?: (message: string, extra?: unknown) => void;
};

/**
 * Order matters. 3.4 first because it is what current firmware ships, and
 * because its handshake fails fast and unambiguously when it is wrong — 3.3 has
 * no handshake, so a wrong guess there only shows up as silence.
 */
const CANDIDATE_ORDER: ProtocolVersion[] = ['3.4', '3.3', '3.5'];

export type Dps = Record<string, string | number | boolean>;

export class TuyaSession {
  #options: SessionOptions;
  #socket: Socket | null = null;
  #reader: FrameReader;
  #localKey: Buffer;
  #sessionKey: Buffer;
  /** The version currently in use — resolved, once something has answered. */
  #version: ProtocolVersion;
  #sequence = 1;
  #connecting: Promise<void> | null = null;
  #heartbeat: ReturnType<typeof setInterval> | null = null;
  #waiters: { match: (frame: TuyaFrame) => boolean; resolve: (f: TuyaFrame) => void; reject: (e: Error) => void }[] = [];

  constructor(options: SessionOptions) {
    this.#options = options;
    this.#localKey = Buffer.from(options.localKey, 'utf8');
    this.#sessionKey = this.#localKey;
    this.#version = options.version === 'auto' ? CANDIDATE_ORDER[0]! : options.version;
    this.#reader = new FrameReader(this.#version, this.#localKey);
  }

  get connected(): boolean {
    return this.#socket !== null && !this.#socket.destroyed;
  }

  /** Which protocol actually worked. Worth showing, and worth saving back. */
  get version(): ProtocolVersion {
    return this.#version;
  }

  /** The versions to try, best guess first. */
  #candidates(): ProtocolVersion[] {
    if (this.#options.version === 'auto') return CANDIDATE_ORDER;
    // An explicit choice is tried first, but not treated as gospel: falling
    // back beats failing when someone picked from a dropdown by guesswork.
    return [this.#options.version, ...CANDIDATE_ORDER.filter((v) => v !== this.#options.version)];
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    this.#connecting ??= this.#openConnection().finally(() => {
      this.#connecting = null;
    });
    return this.#connecting;
  }

  /**
   * Connects, trying each protocol version until the device answers.
   *
   * A wrong version and a wrong key look the same from the outside — silence on
   * 3.3, a refused handshake on 3.4 — so the only honest way to tell them apart
   * is to try, and to say afterwards which one worked.
   */
  async #openConnection(): Promise<void> {
    if (this.#localKey.length !== 16) {
      throw new Error(
        `The local key must be 16 characters; got ${this.#localKey.length}. ` +
          `Extract it with \`tuya-cli wizard\` or \`python -m tinytuya wizard\`.`
      );
    }

    const failures: string[] = [];

    for (const candidate of this.#candidates()) {
      try {
        await this.#openAs(candidate);
        if (candidate !== this.#options.version) {
          this.#options.log?.(`speaking protocol ${candidate}`);
        }
        return;
      } catch (error) {
        failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
        this.#teardown();
      }
    }

    throw new Error(failures.join(' | '));
  }

  async #openAs(version: ProtocolVersion): Promise<void> {
    const { host } = this.#options;
    this.#version = version;

    const socket = new Socket();
    socket.setNoDelay(true);
    this.#sessionKey = this.#localKey;
    // A fresh reader: the framing itself differs between 3.4 and 3.5, so the
    // previous attempt's parser cannot be reused.
    this.#reader = new FrameReader(version, this.#localKey);

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`No answer from ${host}:${PORT} within ${CONNECT_TIMEOUT_MS}ms`));
      }, CONNECT_TIMEOUT_MS);

      socket.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      socket.connect(PORT, host, () => {
        clearTimeout(timer);
        resolve();
      });
    });

    socket.on('data', (chunk) => {
      // No encoding is ever set on this socket, so a string cannot actually
      // arrive — but the type allows one, and coercing beats an assertion.
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'binary') : chunk;
      for (const frame of this.#reader.push(bytes)) this.#deliver(frame);
    });
    socket.on('close', () => this.#teardown());
    socket.on('error', (error) => {
      this.#options.log?.('socket error', error.message);
      this.#teardown();
    });

    this.#socket = socket;

    if (version === '3.4' || version === '3.5') await this.#negotiate();

    /*
      Prove the guess before declaring victory. 3.4 and 3.5 announce a wrong
      version by failing the handshake above, but 3.3 has no handshake at all —
      a wrong version there just produces silence or unparseable frames, which
      is indistinguishable from a broken plug unless we ask it something.

      An empty answer counts as failure. A TCP connection proves the plug is
      there; it proves nothing about the key, and a wrong key decrypts to
      nonsense that parses as "no datapoints". Accepting that would report a
      healthy link over no data at all.
    */
    const probe = await this.#query();
    if (Object.keys(probe).length === 0) {
      throw new Error(
        'connected, but no datapoints could be decoded — usually a wrong local key'
      );
    }

    // These devices drop an idle connection, and on 3.4/3.5 that costs the
    // session key as well as the socket.
    this.#heartbeat = setInterval(() => {
      void this.#send(CMD.HEART_BEAT, Buffer.from('{}')).catch(() => {});
    }, HEARTBEAT_MS);
  }

  /**
   * The three-message session handshake used by 3.4 and 3.5.
   *
   * Both sides prove they hold the local key, and the session key is derived
   * from the two nonces so that a captured session cannot be replayed.
   */
  async #negotiate(): Promise<void> {
    const localNonce = randomBytes(16);

    const response = await this.#exchange(
      CMD.SESS_KEY_NEG_START,
      localNonce,
      (frame) => frame.command === CMD.SESS_KEY_NEG_RESP
    );

    if (response.payload.length < 48) {
      throw new Error(
        'The device refused the session handshake. Usually a wrong local key, ' +
          'or another client already holds its single connection.'
      );
    }

    const remoteNonce = response.payload.subarray(0, 16);
    const proof = response.payload.subarray(16, 48);

    if (!hmacSha256(this.#localKey, localNonce).equals(proof)) {
      throw new Error('The device failed to prove it holds the same local key.');
    }

    await this.#send(CMD.SESS_KEY_NEG_FINISH, hmacSha256(this.#localKey, remoteNonce));

    const mixed = Buffer.alloc(16);
    for (let i = 0; i < 16; i++) mixed[i] = localNonce[i]! ^ remoteNonce[i]!;

    this.#sessionKey =
      this.#version === '3.5'
        ? aesGcmEncrypt(this.#localKey, localNonce.subarray(0, 12), mixed, Buffer.alloc(0)).ciphertext.subarray(0, 16)
        : aesEcbEncrypt(this.#localKey, mixed).subarray(0, 16);

    this.#reader.useKey(this.#sessionKey);
  }

  /** Reads every datapoint the device will report. */
  async status(): Promise<Dps> {
    await this.connect();
    return this.#query();
  }

  /** The query itself, without connecting — the connect path uses it to probe. */
  async #query(): Promise<Dps> {
    const { deviceId } = this.#options;

    const modern = this.#version === '3.4' || this.#version === '3.5';
    const command = modern ? CMD.DP_QUERY_NEW : CMD.DP_QUERY;
    const payload = modern
      ? { protocol: 4, t: Math.floor(Date.now() / 1000), data: {} }
      : { gwId: deviceId, devId: deviceId, uid: deviceId, t: Math.floor(Date.now() / 1000) };

    const frame = await this.#exchange(
      command,
      Buffer.from(JSON.stringify(payload)),
      (f) => f.payload.length > 0 && (f.command === command || f.command === CMD.STATUS || f.command === CMD.DP_QUERY)
    );

    return parseDps(frame.payload);
  }

  /** Writes datapoints. The caller is the action gateway, never a plugin. */
  async set(dps: Dps): Promise<Dps> {
    await this.connect();
    const { deviceId } = this.#options;

    const modern = this.#version === '3.4' || this.#version === '3.5';
    const command = modern ? CMD.CONTROL_NEW : CMD.CONTROL;
    const payload = modern
      ? { protocol: 5, t: Math.floor(Date.now() / 1000), data: { dps } }
      : { devId: deviceId, uid: deviceId, t: Math.floor(Date.now() / 1000), dps };

    const frame = await this.#exchange(
      command,
      Buffer.from(JSON.stringify(payload)),
      (f) => f.command === command || f.command === CMD.STATUS || f.command === CMD.CONTROL
    );

    if (frame.returnCode !== 0) {
      throw new Error(`The device rejected the command (code ${frame.returnCode})`);
    }

    return parseDps(frame.payload);
  }

  async close(): Promise<void> {
    this.#teardown();
  }

  #teardown(): void {
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#heartbeat = null;
    for (const waiter of this.#waiters) waiter.reject(new Error('Connection closed'));
    this.#waiters = [];
    const socket = this.#socket;
    this.#socket = null;
    socket?.removeAllListeners();
    socket?.destroy();
  }

  #deliver(frame: TuyaFrame): void {
    const index = this.#waiters.findIndex((waiter) => waiter.match(frame));
    if (index < 0) return; // unsolicited status push; the next poll picks it up
    const [waiter] = this.#waiters.splice(index, 1);
    waiter?.resolve(frame);
  }

  async #exchange(
    command: number,
    payload: Buffer,
    match: (frame: TuyaFrame) => boolean
  ): Promise<TuyaFrame> {
    const waiting = new Promise<TuyaFrame>((resolve, reject) => {
      const waiter = { match, resolve, reject };
      this.#waiters.push(waiter);
      setTimeout(() => {
        const index = this.#waiters.indexOf(waiter);
        if (index < 0) return;
        this.#waiters.splice(index, 1);
        reject(new Error(`The device did not answer command 0x${command.toString(16)} in ${REQUEST_TIMEOUT_MS}ms`));
      }, REQUEST_TIMEOUT_MS);
    });

    await this.#send(command, payload);
    return waiting;
  }

  async #send(command: number, payload: Buffer): Promise<void> {
    const socket = this.#socket;
    if (!socket) throw new Error('Not connected');

    const frame = encodeFrame({
      version: this.#version,
      key: this.#sessionKey,
      sequence: this.#sequence++,
      command,
      payload,
      iv: this.#version === '3.5' ? randomBytes(12) : undefined,
    });

    await new Promise<void>((resolve, reject) => {
      socket.write(frame, (error) => (error ? reject(error) : resolve()));
    });
  }
}

/** Pulls the `dps` object out of whatever shape the device replied with. */
export function parseDps(payload: Buffer): Dps {
  const text = payload.toString('utf8').replace(/\0+$/, '').trim();
  if (!text) return {};

  const start = text.indexOf('{');
  if (start < 0) return {};

  const json = JSON.parse(text.slice(start)) as Record<string, unknown>;
  // 3.3 answers { dps: {...} }; 3.4/3.5 wrap it as { protocol, t, data: { dps } }.
  const container = (json.data ?? json) as Record<string, unknown>;
  const dps = container.dps;
  return dps && typeof dps === 'object' ? (dps as Dps) : {};
}
