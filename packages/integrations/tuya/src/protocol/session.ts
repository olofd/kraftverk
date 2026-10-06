import type { ByteChannel } from '@kraftverk/device-sdk';

import { equal, randomBytes, text, utf8 } from './bytes.ts';
import { aesEcbEncrypt, aesGcmEncrypt } from './crypto/aes.ts';
import { hmacSha256 } from './crypto/hash.ts';
import { CMD, encodeFrame, FrameReader, type ProtocolVersion, type TuyaFrame } from './frame.ts';
import type { Dps } from './socket.ts';

/**
 * One conversation with a Tuya device, over the byte channel it was given.
 *
 * 3.3 needs no handshake: every frame is AES-ECB with the local key. 3.4 and
 * 3.5 negotiate a session key first, per connection — so whenever the channel
 * reconnects, the next request negotiates again, and trying another version
 * means asking the channel for a fresh connection.
 *
 * Everything here follows the published protocol description in tinytuya's
 * PROTOCOL.md; see docs/ATORCH-S1W.md §1.
 */

/** The port a Tuya device listens on. The binding asks the transport for it. */
export const TUYA_PORT = 6668;

const CONNECT_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 5_000;
const HEARTBEAT_MS = 10_000;

export type TuyaLinkOptions = {
  deviceId: string;
  localKey: string;
  /**
   * `auto` tries each version until one answers, which is usually the right
   * setting: the version is a property of the firmware, people rarely know it,
   * and getting it wrong looks identical to a wrong key.
   */
  version: ProtocolVersion | 'auto';
  log?: (message: string) => void;
  /** How long a request waits for its answer; 5 s unless said (a test says less). */
  requestTimeoutMs?: number;
  /** How often an idle session says it is there; 10 s unless said. */
  heartbeatMs?: number;
  /**
   * Datapoints sent unasked: a change at the plug, or its own refresh. Through
   * a gateway, `cid` says which device behind it they are of; null for a
   * device spoken to directly, and for the gateway's own.
   */
  onPush?: (dps: Dps, cid: string | null) => void;
  /**
   * A gateway's link: one conversation with a Tuya gateway, with its key, for
   * every device behind it — each named, by its Zigbee address (`cid`), in
   * the requests about it. Its key is proven by the handshake (3.4, 3.5), or
   * on 3.3 by asking about one of its `members`, when it has any yet.
   */
  gateway?: { members(): readonly string[] };
  /** A gateway saying it can, or cannot, reach a device behind it. */
  onPresence?: (cid: string, online: boolean) => void;
};

/** Which device behind a gateway a frame is about: `cid` at its top, or in its `data`. Null for the gateway's own. */
export function cidOf(payload: Uint8Array): string | null {
  const decoded = text(payload).replace(/\0+$/, '').trim();
  const start = decoded.indexOf('{');
  if (start < 0) return null;
  try {
    const json = JSON.parse(decoded.slice(start)) as { cid?: unknown; data?: { cid?: unknown } };
    const cid = json.cid ?? json.data?.cid;
    return typeof cid === 'string' ? cid : null;
  } catch {
    return null;
  }
}

/** A gateway's report of which of its devices are reachable: `subdev_online_stat_report`, on LAN_EXT_STREAM. */
export function presenceOf(payload: Uint8Array): { online: string[]; offline: string[] } | null {
  try {
    const json = JSON.parse(text(payload).replace(/\0+$/, '').trim()) as { reqType?: unknown; data?: { online?: unknown; offline?: unknown } };
    if (json.reqType !== 'subdev_online_stat_report') return null;
    const list = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
    return { online: list(json.data?.online), offline: list(json.data?.offline) };
  } catch {
    return null;
  }
}

/**
 * Order matters. 3.4 first because it is what current firmware ships, and
 * because its handshake fails fast and unambiguously when it is wrong — 3.3 has
 * no handshake, so a wrong guess there only shows up as silence.
 */
const CANDIDATE_ORDER: ProtocolVersion[] = ['3.4', '3.3', '3.5'];

type Waiter = { match: (frame: TuyaFrame) => boolean; resolve: (frame: TuyaFrame) => void; reject: (error: Error) => void };

export class TuyaLink {
  #channel: ByteChannel;
  #options: TuyaLinkOptions;
  #localKey: Uint8Array;
  #sessionKey: Uint8Array;
  #version: ProtocolVersion;
  /** The version that last worked, tried first next time. */
  #found: ProtocolVersion | null = null;
  #reader: FrameReader;
  #sequence = 1;
  /** Counts the channel's connections; a link is ready for one of them. */
  #epoch = 0;
  #readyFor = -1;
  #establishing: Promise<void> | null = null;
  #heartbeat: ReturnType<typeof setInterval> | null = null;
  /** When anything at all last came from the device, by this clock: what tells a live connection from one whose device has gone. */
  #heardAt = 0;
  #waiters: Waiter[] = [];
  #detach: (() => void)[];

  constructor(channel: ByteChannel, options: TuyaLinkOptions) {
    this.#channel = channel;
    this.#options = options;
    this.#localKey = utf8(options.localKey);
    this.#sessionKey = this.#localKey;
    this.#version = options.version === 'auto' ? CANDIDATE_ORDER[0]! : options.version;
    this.#reader = new FrameReader(this.#version, this.#localKey);
    this.#detach = [
      channel.onData((bytes) => {
        this.#heardAt = Date.now();
        for (const frame of this.#reader.push(bytes)) this.#deliver(frame);
      }),
      channel.onConnectedChange((connected) => {
        // A new connection: a 3.4 session key belongs to the old one.
        this.#epoch += 1;
        this.#readyFor = -1;
        this.#reader.reset();
        if (!connected) this.#failWaiters('Connection closed');
      }),
    ];
  }

  /** Talking, with a session that works, right now. */
  get connected(): boolean {
    return this.#channel.connected && this.#readyFor === this.#epoch;
  }

  /** Which protocol actually worked. Worth showing, and worth saving back. */
  get version(): ProtocolVersion {
    return this.#version;
  }

  /** Talks, if it is not talking already: what a gateway's link does to stand ready for the devices behind it. */
  async open(): Promise<void> {
    await this.#ensure();
  }

  /**
   * Reads every datapoint the device will report — through a gateway, of the
   * device behind it named by `cid`, as the gateway last heard it.
   */
  async status(cid?: string): Promise<Dps> {
    await this.#ensure();
    try {
      return await this.#query(cid);
    } catch (error) {
      // The gateway answers about what it has: silence about one device, with the connection good, is a device it does not have.
      if (cid && this.connected && /did not answer/.test((error as Error).message)) throw new Error(`the gateway answered, but says nothing of ${cid}: is it paired with this gateway?`);
      throw error;
    }
  }

  /**
   * Asks the device to measure datapoints again. What changed comes as a push
   * (`onPush`), within a moment; what did not change is not said again, so
   * silence is no proof the device measured. Nothing waits for it: the
   * acknowledgement is the gateway's, not the device's.
   *
   * Behind a gateway it is how the device is asked at all — a query answers
   * from the gateway's memory, and a Zigbee plug's power is in it only while
   * something asks. The device is named in a list, as Smart Life does on the
   * home network; named bare, as tinytuya does, a gateway acknowledges it and
   * asks nothing (packages/devices/tuya-zigbee-plug/README.md).
   */
  async refresh(dps: readonly number[], cid?: string): Promise<void> {
    await this.#ensure();
    await this.#send(CMD.UPDATEDPS, utf8(JSON.stringify(cid ? { dpId: dps, cid: [cid] } : { dpId: dps })));
  }

  /** Writes datapoints — through a gateway, to the device behind it named by `cid`. The caller is the action gateway's path, never a screen directly. */
  async set(dps: Dps, cid?: string): Promise<Dps> {
    await this.#ensure();
    const { deviceId } = this.#options;
    const modern = this.#version === '3.4' || this.#version === '3.5';
    const command = modern ? CMD.CONTROL_NEW : CMD.CONTROL;
    const t = Math.floor(Date.now() / 1000);
    // Behind a gateway, the device is named in the request: at the top on 3.3, in its data on 3.4 and 3.5.
    const payload = modern
      ? { protocol: 5, t, data: cid ? { cid, ctype: 0, dps } : { dps } }
      : cid
        ? { t, cid, dps }
        : { devId: deviceId, uid: deviceId, t, dps };

    // A gateway acknowledges with an empty frame of the command, then says what changed as a status.
    const frame = await this.#exchange(
      command,
      utf8(JSON.stringify(payload)),
      (f) => f.command === command || ((f.command === CMD.STATUS || f.command === CMD.CONTROL) && this.#about(f, cid))
    );
    if (frame.returnCode !== 0) throw new Error(`The device rejected the command (code ${frame.returnCode})`);
    return parseDps(frame.payload);
  }

  /** Stops listening. The channel stays open: it belongs to whoever opened it. */
  async close(): Promise<void> {
    this.#stopHeartbeat();
    this.#failWaiters('Link closed');
    for (const detach of this.#detach) detach();
    this.#detach = [];
  }

  // --- establishing a session ------------------------------------------------------

  async #ensure(): Promise<void> {
    if (this.connected) return;
    this.#establishing ??= this.#establish().finally(() => {
      this.#establishing = null;
    });
    return this.#establishing;
  }

  /** The versions to try, best guess first. */
  #candidates(): ProtocolVersion[] {
    const first = this.#found ?? (this.#options.version === 'auto' ? null : this.#options.version);
    // An explicit choice is tried first, but not treated as gospel: falling
    // back beats failing when someone picked from a dropdown by guesswork.
    return first ? [first, ...CANDIDATE_ORDER.filter((v) => v !== first)] : CANDIDATE_ORDER;
  }

  /**
   * Talks, trying each protocol version until the device answers.
   *
   * A wrong version and a wrong key look the same from the outside — silence
   * on 3.3, a refused handshake on 3.4 — so the only honest way to tell them
   * apart is to try, and to say afterwards which one worked.
   */
  async #establish(): Promise<void> {
    if (this.#localKey.length !== 16) {
      throw new Error(
        `The local key must be 16 characters; got ${this.#localKey.length}. ` +
          'Fetch it with a Tuya cloud project (docs/TUYA-LOCAL-KEY.md).'
      );
    }

    const failures: string[] = [];
    const candidates = this.#candidates();
    for (const [index, candidate] of candidates.entries()) {
      try {
        await this.#openAs(candidate);
        if (candidate !== this.#found) this.#options.log?.(`speaking protocol ${candidate}`);
        this.#found = candidate;
        return;
      } catch (error) {
        failures.push(`${candidate}: ${(error as Error).message}`);
        this.#stopHeartbeat();
        // A failed handshake leaves the device expecting a new connection.
        if (index < candidates.length - 1) await this.#channel.reset?.().catch(() => undefined);
      }
    }
    throw new Error(failures.join(' | '));
  }

  async #openAs(version: ProtocolVersion): Promise<void> {
    await this.#connectedWithin(CONNECT_TIMEOUT_MS);
    const epoch = this.#epoch;

    this.#version = version;
    this.#sessionKey = this.#localKey;
    // A fresh reader: the framing itself differs between 3.4 and 3.5.
    this.#reader = new FrameReader(version, this.#localKey);

    if (version === '3.4' || version === '3.5') await this.#negotiate();

    /*
      Prove the guess before declaring victory. 3.4 and 3.5 announce a wrong
      version by failing the handshake above, but 3.3 has no handshake at all —
      a wrong version there just produces silence or unparseable frames, which
      is indistinguishable from a broken plug unless we ask it something.

      An empty answer counts as failure. A connection proves the plug is there;
      it proves nothing about the key, and a wrong key decrypts to nonsense
      that parses as "no datapoints".
    */
    const gateway = this.#options.gateway;
    if (!gateway) {
      const probe = await this.#query();
      if (Object.keys(probe).length === 0) throw new Error('connected, but no datapoints could be decoded — usually a wrong local key');
    } else if (version === '3.3') {
      // A gateway on 3.3 has no handshake to prove its key: asked about a device behind it, when it has one yet.
      const member = gateway.members()[0];
      if (member) {
        const probe = await this.#query(member);
        if (Object.keys(probe).length === 0) throw new Error('connected, but no datapoints could be decoded — usually a wrong local key');
      }
    }

    this.#readyFor = epoch;
    /*
      These devices drop an idle connection, and on 3.4/3.5 that costs the
      session key as well as the socket: a heartbeat keeps it. And one that
      loses its power closes nothing — its connection looks open for minutes,
      until it is back and refuses it. So a heartbeat is answered, or the
      connection is taken for gone: two beats of silence, and it is opened
      afresh — which fails, and says so, until the device is there again.
    */
    this.#stopHeartbeat();
    const beat = this.#options.heartbeatMs ?? HEARTBEAT_MS;
    this.#heartbeat = setInterval(() => {
      if (!this.connected) return;
      if (Date.now() - this.#heardAt > beat * 2) return void this.#gone(`nothing heard for ${Math.round((Date.now() - this.#heardAt) / 1000)} s`);
      void this.#send(CMD.HEART_BEAT, utf8('{}')).catch(() => {});
    }, beat);
  }

  #connectedWithin(ms: number): Promise<void> {
    if (this.#channel.connected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        stop();
        reject(new Error(`No answer within ${ms} ms`));
      }, ms);
      const stop = this.#channel.onConnectedChange((connected) => {
        if (!connected) return;
        clearTimeout(timer);
        stop();
        resolve();
      });
    });
  }

  /**
   * The three-message session handshake used by 3.4 and 3.5.
   *
   * Both sides prove they hold the local key, and the session key is derived
   * from the two nonces so that a captured session cannot be replayed.
   */
  async #negotiate(): Promise<void> {
    const localNonce = randomBytes(16);
    const response = await this.#exchange(CMD.SESS_KEY_NEG_START, localNonce, (frame) => frame.command === CMD.SESS_KEY_NEG_RESP);

    if (response.payload.length < 48) {
      throw new Error(
        'The device refused the session handshake. Usually a wrong local key, ' +
          'or another client already holds its single connection.'
      );
    }

    const remoteNonce = response.payload.subarray(0, 16);
    const proof = response.payload.subarray(16, 48);
    if (!equal(hmacSha256(this.#localKey, localNonce), proof)) {
      throw new Error('The device failed to prove it holds the same local key.');
    }

    await this.#send(CMD.SESS_KEY_NEG_FINISH, hmacSha256(this.#localKey, remoteNonce));

    const mixed = new Uint8Array(16);
    for (let i = 0; i < 16; i++) mixed[i] = localNonce[i]! ^ remoteNonce[i]!;

    this.#sessionKey = sessionKeyOf(this.#version, this.#localKey, localNonce, mixed);
    this.#reader.useKey(this.#sessionKey);
  }

  // --- requests ---------------------------------------------------------------------

  /** The query itself, without establishing — establishing uses it to probe. */
  async #query(cid?: string): Promise<Dps> {
    const { deviceId } = this.#options;
    const modern = this.#version === '3.4' || this.#version === '3.5';
    const command = modern ? CMD.DP_QUERY_NEW : CMD.DP_QUERY;
    const t = Math.floor(Date.now() / 1000);
    /*
      Behind a gateway, the device is named at the top — `{"cid": …}`; in the
      data, as a control does it, the gateway answers for itself instead. The
      gateway answers from what it last heard, at once, and asks the device
      nothing: `refresh` does.
    */
    const payload = cid
      ? modern
        ? { cid }
        : { t, cid }
      : modern
        ? { protocol: 4, t, data: {} }
        : { gwId: deviceId, devId: deviceId, uid: deviceId, t };

    const frame = await this.#exchange(
      command,
      utf8(JSON.stringify(payload)),
      (f) => f.payload.length > 0 && (f.command === command || f.command === CMD.STATUS || f.command === CMD.DP_QUERY) && this.#about(f, cid)
    );
    return parseDps(frame.payload);
  }

  /** A frame about the device asked of: any, directly; through a gateway, one naming it — or, for the gateway's own, naming none. */
  #about(frame: TuyaFrame, cid: string | undefined): boolean {
    if (!this.#options.gateway) return true;
    return (cidOf(frame.payload) ?? undefined) === cid;
  }

  #deliver(frame: TuyaFrame): void {
    const index = this.#waiters.findIndex((waiter) => waiter.match(frame));
    if (index < 0) {
      // Unasked: a change at the plug, or its own refresh — through a gateway, with which device it is of.
      if (frame.command === CMD.STATUS) {
        const dps = parseDps(frame.payload);
        if (Object.keys(dps).length) this.#options.onPush?.(dps, this.#options.gateway ? cidOf(frame.payload) : null);
      }
      // A gateway telling which of its devices it can reach.
      if (this.#options.gateway && frame.command === CMD.LAN_EXT_STREAM) {
        const presence = presenceOf(frame.payload);
        for (const cid of presence?.online ?? []) this.#options.onPresence?.(cid, true);
        for (const cid of presence?.offline ?? []) this.#options.onPresence?.(cid, false);
      }
      // A refresh it would not take is said: nothing else would tell.
      if (frame.command === CMD.UPDATEDPS && frame.returnCode !== 0) this.#options.log?.(`a refresh was refused: ${text(frame.payload) || `code ${frame.returnCode}`}`);
      return;
    }
    const [waiter] = this.#waiters.splice(index, 1);
    waiter?.resolve(frame);
  }

  #failWaiters(message: string): void {
    for (const waiter of this.#waiters.splice(0)) waiter.reject(new Error(message));
  }

  async #exchange(command: number, payload: Uint8Array, match: (frame: TuyaFrame) => boolean): Promise<TuyaFrame> {
    const waiting = new Promise<TuyaFrame>((resolve, reject) => {
      const waiter: Waiter = { match, resolve, reject };
      this.#waiters.push(waiter);
      setTimeout(() => {
        const index = this.#waiters.indexOf(waiter);
        if (index < 0) return;
        this.#waiters.splice(index, 1);
        const timeout = this.#options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
        const unanswered = new Error(`The device did not answer command 0x${command.toString(16)} in ${timeout}ms`);
        // Not a word of anything while it waited: not this request unanswered, the connection gone.
        if (!this.connected || Date.now() - this.#heardAt < timeout) return reject(unanswered);
        // A gateway says nothing of a device it does not have: whether it is there at all is asked before it is given up.
        void (this.#options.gateway ? this.#stillThere() : Promise.resolve(false)).then((there) => {
          if (!there) this.#gone(`nothing heard for ${Math.round(timeout / 1000)} s`);
          reject(unanswered);
        });
      }, this.#options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS);
    });
    // A connection closed while the request is written fails the waiter before it is returned to anyone: handled here, said below.
    waiting.catch(() => undefined);
    try {
      await this.#send(command, payload);
    } catch (error) {
      const index = this.#waiters.findIndex((waiter) => waiter.match === match);
      if (index >= 0) this.#waiters.splice(index, 1);
      throw error;
    }
    return waiting;
  }

  async #send(command: number, payload: Uint8Array): Promise<void> {
    const frame = encodeFrame({
      version: this.#version,
      key: this.#sessionKey,
      sequence: this.#sequence++,
      command,
      payload,
      iv: this.#version === '3.5' ? randomBytes(12) : undefined,
    });
    await this.#channel.write(frame);
  }

  /** Whether the other end still answers: a heartbeat, and a moment for anything at all to come back. */
  async #stillThere(): Promise<boolean> {
    if (!this.#channel.connected) return false;
    const before = this.#heardAt;
    await this.#send(CMD.HEART_BEAT, utf8('{}')).catch(() => undefined);
    const until = Date.now() + Math.min(this.#options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS, 1_000);
    while (Date.now() < until) {
      if (this.#heardAt > before) return true;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return this.#heardAt > before;
  }

  /**
   * The connection taken for gone: whoever waits is told, and it is opened
   * afresh — the next request connects again, and fails until the device is
   * there to answer.
   */
  #gone(why: string): void {
    // Once for each connection: a heartbeat and a request may both find it silent.
    if (!this.connected) return;
    this.#options.log?.(`the connection is gone: ${why}`);
    this.#stopHeartbeat();
    this.#readyFor = -1;
    this.#failWaiters(`The connection was lost: ${why}`);
    void this.#channel.reset?.().catch(() => undefined);
  }

  #stopHeartbeat(): void {
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#heartbeat = null;
  }
}

/** The 3.4/3.5 session key, from the local key and the two nonces mixed. */
export function sessionKeyOf(version: ProtocolVersion, localKey: Uint8Array, localNonce: Uint8Array, mixed: Uint8Array): Uint8Array {
  return version === '3.5'
    ? aesGcmEncrypt(localKey, localNonce.subarray(0, 12), mixed, new Uint8Array()).ciphertext.subarray(0, 16)
    : aesEcbEncrypt(localKey, mixed).subarray(0, 16);
}

/** Pulls the `dps` object out of whatever shape the device replied with. */
export function parseDps(payload: Uint8Array): Dps {
  const decoded = text(payload).replace(/\0+$/, '').trim();
  if (!decoded) return {};
  const start = decoded.indexOf('{');
  if (start < 0) return {};
  try {
    const json = JSON.parse(decoded.slice(start)) as Record<string, unknown>;
    // 3.3 answers { dps: {...} }; 3.4/3.5 wrap it as { protocol, t, data: { dps } }.
    const container = (json.data ?? json) as Record<string, unknown>;
    const dps = container.dps;
    return dps && typeof dps === 'object' ? (dps as Dps) : {};
  } catch {
    return {};
  }
}
