import type { ByteChannel } from '@kraftverk/device-sdk';

import { CompanionLink, type Message } from './companion.ts';
import { randomBytes } from './crypto.ts';
import { idText, type Credentials } from './pairing.ts';

/*
  What a verified Companion connection says, as pyatv's companion API says
  it (MIT; NOTICE): this side introduced (`_systemInfo`), a session begun
  with the TV's remote service (`_sessionStart`), events asked for
  (`_interest`), and the remote's keys, media control, apps and whether it
  is awake.
*/

/** The remote's keys, as `_hidC` names them. */
export const HidKey = {
  up: 1,
  down: 2,
  left: 3,
  right: 4,
  menu: 5,
  select: 6,
  home: 7,
  volumeUp: 8,
  volumeDown: 9,
  siri: 10,
  screensaver: 11,
  sleep: 12,
  wake: 13,
  playPause: 14,
  channelUp: 15,
  channelDown: 16,
  guide: 17,
  pageUp: 18,
  pageDown: 19,
} as const;
export type HidKeyName = keyof typeof HidKey;

/** Media control, as `_mcc` names it. */
export const MediaCommand = {
  play: 1,
  pause: 2,
  next: 3,
  previous: 4,
  getVolume: 5,
  setVolume: 6,
  skipBy: 7,
  fastForwardBegin: 8,
  fastForwardEnd: 9,
  rewindBegin: 10,
  rewindEnd: 11,
  getCaptionSettings: 12,
  setCaptionSettings: 13,
} as const;

/** Whether the TV is awake, as `FetchAttentionState` and the `SystemStatus` event say. */
export type Attention = 'asleep' | 'screensaver' | 'awake' | 'idle' | 'unknown';
const ATTENTION: Readonly<Record<number, Attention>> = { 1: 'asleep', 2: 'screensaver', 3: 'awake', 4: 'idle' };
export const attentionOf = (state: unknown): Attention => (typeof state === 'number' ? (ATTENTION[state] ?? 'unknown') : 'unknown');

/** The events a session asks the TV for. */
export const EVENTS = ['_iMC', 'SystemStatus', 'TVSystemStatus'] as const;

/** How long a key is held, pressed: as a remote's press. */
const PRESS_MS = 50;

const randomHex = (bytes: number): string => [...randomBytes(bytes)].map((each) => each.toString(16).padStart(2, '0')).join('');

/** A session with an Apple TV over Companion: verified, introduced, begun. */
export class CompanionSession {
  private constructor(
    readonly link: CompanionLink,
    /** The TV's remote session, joined to this side's. */
    readonly sessionId: bigint,
  ) {}

  /** Verifies with the credentials pairing left, says who this side is, and begins the remote's session. */
  static async start(channel: ByteChannel, credentials: Credentials, name = 'kraftverk', timeoutMs?: number): Promise<CompanionSession> {
    const link = new CompanionLink(channel, timeoutMs);
    try {
      await link.verify(credentials);
      await link.request('_systemInfo', {
        _bf: 0,
        _cf: 512,
        _clFl: 128,
        _i: randomHex(6),
        _idsID: idText(credentials.clientId),
        _pubID: randomHex(6).replace(/(..)(?!$)/g, '$1:').toUpperCase(),
        _sf: 256,
        _sv: '170.18',
        model: 'iPhone14,3',
        name,
      });
      const local = crypto.getRandomValues(new Uint32Array(1))[0]!;
      const started = await link.request('_sessionStart', { _srvT: 'com.apple.tvremoteservices', _sid: local });
      const remote = typeof started._sid === 'number' ? started._sid : 0;
      const session = new CompanionSession(link, (BigInt(remote) << 32n) | BigInt(local));
      for (const event of EVENTS) await link.event('_interest', { _regEvents: [event] });
      return session;
    } catch (error) {
      await link.close();
      throw error;
    }
  }

  /** A key on the remote, pressed and let go. */
  async press(key: HidKeyName): Promise<void> {
    await this.link.request('_hidC', { _hBtS: 1, _hidC: HidKey[key] });
    await new Promise((resolve) => setTimeout(resolve, PRESS_MS));
    await this.link.request('_hidC', { _hBtS: 2, _hidC: HidKey[key] });
  }

  /** Media control: play, pause, next — with its arguments. */
  async media(command: keyof typeof MediaCommand, args: Message = {}): Promise<Message> {
    return this.link.request('_mcc', { _mcc: MediaCommand[command], ...args });
  }

  /** The volume, 0–100, where the TV controls one. */
  async volume(): Promise<number | null> {
    const answer = await this.media('getVolume');
    return typeof answer._vol === 'number' ? Math.round(answer._vol * 100) : null;
  }

  async setVolume(percent: number): Promise<void> {
    await this.media('setVolume', { _vol: Math.min(100, Math.max(0, percent)) / 100 });
  }

  /** Whether it is awake. */
  async attention(): Promise<Attention> {
    return attentionOf((await this.link.request('FetchAttentionState')).state);
  }

  /** Wakes it: on. */
  async wake(): Promise<void> {
    await this.press('wake');
  }

  /** Puts it to sleep: off. */
  async sleep(): Promise<void> {
    await this.press('sleep');
  }

  /** The apps it can open: bundle id to name. */
  async apps(): Promise<Record<string, string>> {
    const answer = await this.link.request('FetchLaunchableApplicationsEvent');
    return Object.fromEntries(Object.entries(answer).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  }

  /** Opens an app, by its bundle id. */
  async launch(bundleId: string): Promise<void> {
    await this.link.request('_launchApp', { _bundleID: bundleId });
  }

  /** Ends the remote's session, and the connection. */
  async close(): Promise<void> {
    await this.link.request('_sessionStop', { _srvT: 'com.apple.tvremoteservices', _sid: this.sessionId }).catch(() => undefined);
    await this.link.close();
  }
}
