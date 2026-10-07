import {
  channelOf,
  defineDeviceType,
  directOf,
  MAIN_PART,
  NeedsSignIn,
  needsSignIn,
  type CommandRequest,
  type CommandResult,
  type DeviceContext,
  type DeviceDescription,
  type DeviceSession,
  type DirectMethod,
  type OpenConnection,
  type Reading,
  type SessionHealth,
  type Value,
} from '@kraftverk/device-sdk';
import { COMPANION_LAN } from '@kraftverk/integration-apple-media';
import {
  appleIdentity,
  attentionOf,
  CompanionLink,
  CompanionSession,
  hasVolume,
  PairingRefused,
  pairedWith,
  playingOf,
  type Attention,
  type Credentials,
  type HidKeyName,
} from '@kraftverk/integration-apple-media/protocol';

/*
  An Apple TV, over Companion — Apple's own remote's way in — on the home
  network: on and off (awake or asleep), playing or paused, the remote's
  keys, its apps, and its volume where it controls one. Kept current by
  what it tells as it changes; asked whether it is awake once a minute too,
  so a silence is noticed. Paired once, in setup, with the PIN it shows.

  Ported from pyatv and Home Assistant's `apple_tv` (NOTICE in apple-media).
*/

type Config = Record<string, never>;

/**
 * Companion over the home network, found by what only an Apple TV
 * announces: its model code. A Mac and an iPhone announce Companion too.
 */
const APPLE_TV_LAN: DirectMethod = { ...COMPANION_LAN, discovery: [{ kind: 'mdns', service: '_companion-link._tcp', txt: { rpMd: 'AppleTV*' } }] };

/** How often it is asked whether it is awake, beside what it tells of itself. */
const ASK_EVERY_MS = 60_000;

/** After a command, when it is asked again: the TV tells of the change too, a moment later. */
const SETTLE_MS = [1_000, 3_000];

const CAPABILITIES = ['switch', 'mediaPlayback', 'keypadInput', 'applicationLauncher', 'volume'] as const;

const DESCRIPTION: DeviceDescription = {
  parts: [{ id: MAIN_PART, label: 'Apple TV', kind: 'device', offers: [...CAPABILITIES] }],
  attributes: [
    // On is awake: asleep, it shows nothing and plays nothing.
    { key: 'on', label: 'On', value: { type: 'boolean' }, means: 'on', category: 'primary' },
    { key: 'playing', label: 'Playing', value: { type: 'boolean', words: { true: 'Playing', false: 'Not playing' } }, means: 'playing' },
    { key: 'volume', label: 'Volume', value: { type: 'number', unit: '%', min: 0, max: 100, precision: 0 }, means: 'volume' },
    {
      key: 'screen',
      label: 'Screen',
      value: {
        type: 'enum',
        options: [
          { value: 'awake', label: 'Awake' },
          { value: 'idle', label: 'Idle' },
          { value: 'screensaver', label: 'Screensaver' },
          { value: 'asleep', label: 'Asleep' },
        ],
      },
      category: 'diagnostic',
    },
  ],
};

/** The remote's keys, as the capability names them, to Companion's. */
const KEYS: Readonly<Record<string, HidKeyName>> = {
  up: 'up',
  down: 'down',
  left: 'left',
  right: 'right',
  select: 'select',
  back: 'menu',
  home: 'home',
  playPause: 'playPause',
  volumeUp: 'volumeUp',
  volumeDown: 'volumeDown',
};

/** What it says, as readings are made of it. */
type Said = { screen: Attention | null; flags: number | null; volume: number | null };

function readingsOf(said: Said, at: string): Reading[] {
  const awake = said.screen === null || said.screen === 'unknown' ? null : said.screen !== 'asleep';
  return [
    { key: 'on', value: awake, at },
    // Asleep, nothing plays — whatever it last said could be done.
    { key: 'playing', value: awake === false ? false : playingOf(said.flags), at },
    { key: 'volume', value: hasVolume(said.flags) ? said.volume : null, at },
    { key: 'screen', value: said.screen === 'unknown' ? null : said.screen, at },
  ];
}

const refuse = (request: CommandRequest): CommandResult => ({ accepted: false, error: `An Apple TV takes no ${request.capability}.${request.command}` });

/** What pairing left, from the connection's secret — or a person is asked to pair it again. */
function credentialsOf(connection: OpenConnection): Credentials {
  const credentials = pairedWith(directOf(connection, 'An Apple TV is reached on the home network').secrets.get('credentials'));
  if (!credentials) throw new NeedsSignIn('It is not paired: pair it again, with the PIN it shows');
  return credentials;
}

/** A command, sent on a session begun. What it changes is told by the TV, and asked again after. */
async function send(session: CompanionSession, request: CommandRequest): Promise<CommandResult | null> {
  const { capability, command, args } = request;
  if (capability === 'switch' && command === 'set' && typeof args.on === 'boolean') await (args.on ? session.wake() : session.sleep());
  else if (capability === 'mediaPlayback' && command === 'set' && typeof args.playing === 'boolean') await session.media(args.playing ? 'play' : 'pause');
  else if (capability === 'mediaPlayback' && command === 'next') await session.media('next');
  else if (capability === 'mediaPlayback' && command === 'previous') await session.media('previous');
  else if (capability === 'keypadInput' && command === 'press' && typeof args.key === 'string' && KEYS[args.key]) await session.press(KEYS[args.key]!);
  else if (capability === 'applicationLauncher' && command === 'launch' && typeof args.app === 'string' && args.app) await session.launch(args.app);
  else if (capability === 'volume' && command === 'set' && typeof args.level === 'number') await session.setVolume(args.level);
  else return null;
  return { accepted: true };
}

/** The apps it can open, by name: as the capability answers them. */
const appsOf = (apps: Record<string, string>): Value =>
  Object.entries(apps)
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));

async function realSession(ctx: DeviceContext<Config>): Promise<DeviceSession> {
  const connection = ctx.connection;
  if (!connection) throw new Error('An Apple TV session needs a connection');
  const channel = channelOf(connection, 'bytes', 'An Apple TV is reached over TCP');
  const said: Said = { screen: null, flags: null, volume: null };
  let session: CompanionSession | null = null;
  let credentials: Credentials | null = null;
  let at = new Date(ctx.clock.now()).toISOString();
  let lastOk: number | null = null;
  let lastError: Error | null = null;
  let closed = false;
  /** What is asked again after a command, until it is closed. */
  const settling = new Set<ReturnType<typeof setTimeout>>();

  const took = () => {
    at = new Date(ctx.clock.now()).toISOString();
    lastOk = Date.now();
    lastError = null;
    ctx.changed();
  };
  const failed = (error: Error) => {
    lastError = error instanceof PairingRefused ? new NeedsSignIn(error.message) : error;
    ctx.changed();
  };

  const link = new CompanionLink(channel);
  // What it tells as it changes: what can be done now — playing or paused, its volume — and whether it is awake.
  link.onEvent('_iMC', (content) => {
    said.flags = typeof content._mcF === 'number' ? content._mcF : said.flags;
    took();
    if (hasVolume(said.flags)) void askVolume();
  });
  for (const event of ['SystemStatus', 'TVSystemStatus']) {
    link.onEvent(event, (content) => {
      said.screen = attentionOf(content.state);
      took();
    });
  }

  const askVolume = async () => {
    if (closed) return;
    const level = await session?.volume().catch(() => null);
    if (level !== undefined && level !== null) {
      said.volume = level;
      took();
    }
  };
  const ask = async () => {
    if (!session || closed) return;
    try {
      said.screen = await session.attention();
      took();
    } catch (error) {
      failed(error as Error);
    }
  };
  // Verified and begun on every connection: the keys are each connection's own.
  const begin = async () => {
    try {
      credentials ??= credentialsOf(connection);
      session = await CompanionSession.begin(link, credentials);
      if (closed) return;
      await ask();
    } catch (error) {
      session = null;
      failed(error as Error);
    }
  };
  channel.onConnectedChange((connected) => {
    if (connected) void begin();
    else {
      session = null;
      ctx.changed();
    }
  });
  ctx.schedule(ASK_EVERY_MS, ask);
  // Not awaited: a TV that is unplugged must not stop its session opening.
  if (channel.connected) void begin();

  return {
    health(): SessionHealth {
      if (lastError && needsSignIn(lastError)) return { status: 'needs-you', detail: lastError.message, lastReadingAt: lastOk ? at : null };
      if (session && channel.connected) return { status: 'connected', detail: 'Connected', lastReadingAt: at };
      return { status: lastOk === null && !lastError ? 'connecting' : 'offline', detail: lastError?.message ?? 'Not answering on the home network', lastReadingAt: lastOk ? at : null };
    },
    readings: () => readingsOf(said, at),
    identity: () => ({ id: credentials ? appleIdentity(credentials) : null, name: null }),
    async command(request) {
      if (request.part !== MAIN_PART) return refuse(request);
      if (ctx.readOnly) return { accepted: false, error: 'Every hardware write is refused: this holder is read-only' };
      if (!session) return { accepted: false, error: lastError?.message ?? 'It is not answering on the home network' };
      try {
        const result = (await send(session, request)) ?? refuse(request);
        if (result.accepted) {
          for (const after of SETTLE_MS) {
            const timer = setTimeout(() => {
              settling.delete(timer);
              void (request.capability === 'volume' ? askVolume() : ask());
            }, after);
            settling.add(timer);
          }
        }
        return result;
      } catch (error) {
        return { accepted: false, error: (error as Error).message };
      }
    },
    async query(request) {
      if (request.capability !== 'applicationLauncher' || request.query !== 'apps') throw new Error(`An Apple TV answers no ${request.capability}.${request.query}`);
      if (!session) throw new Error('It is not answering on the home network');
      return appsOf(await session.apps());
    },
    async close() {
      closed = true;
      for (const timer of settling) clearTimeout(timer);
      await session?.end();
      await link.close();
    },
  };
}

/** An Apple TV that is not there: awake, something playing, its apps and its volume. */
function simulatedSession(ctx: DeviceContext<Config>): DeviceSession {
  const said: Said = { screen: ctx.store.get<Attention>('simulator.screen') ?? 'awake', flags: null, volume: ctx.store.get<number>('simulator.volume') ?? 30 };
  let playing = ctx.store.get<boolean>('simulator.playing') ?? true;
  let at = new Date(ctx.clock.now()).toISOString();
  // What can be done, as the TV says it: pause what plays, play what is paused; its volume, always.
  const flags = () => (playing ? 0x0002 | 0x0004 | 0x0008 : 0x0001) | 0x0100;
  const keep = () => {
    said.flags = flags();
    at = new Date(ctx.clock.now()).toISOString();
    ctx.store.set('simulator.screen', said.screen);
    ctx.store.set('simulator.playing', playing);
    ctx.store.set('simulator.volume', said.volume);
    ctx.changed();
  };
  said.flags = flags();
  const apps = { 'com.apple.TVWatchList': 'TV', 'com.apple.TVMusic': 'Music', 'com.example.Films': 'Films' };
  return {
    health: () => ({ status: 'connected', detail: 'Simulated', lastReadingAt: at }),
    readings: () => readingsOf(said, at),
    identity: () => ({ id: 'apple-media:simulated', name: null }),
    async command(request) {
      if (request.part !== MAIN_PART) return refuse(request);
      if (ctx.readOnly) return { accepted: false, error: 'Every hardware write is refused: this holder is read-only' };
      const { capability, command, args } = request;
      if (capability === 'switch' && command === 'set' && typeof args.on === 'boolean') {
        said.screen = args.on ? 'awake' : 'asleep';
        if (!args.on) playing = false;
      } else if (capability === 'mediaPlayback' && command === 'set' && typeof args.playing === 'boolean') {
        if (said.screen === 'asleep') said.screen = 'awake';
        playing = args.playing;
      } else if (capability === 'volume' && command === 'set' && typeof args.level === 'number') said.volume = Math.round(Math.min(100, Math.max(0, args.level)));
      else if (capability === 'applicationLauncher' && command === 'launch' && typeof args.app === 'string' && Object.hasOwn(apps, args.app)) playing = true;
      else if (!(capability === 'mediaPlayback' && (command === 'next' || command === 'previous')) && !(capability === 'keypadInput' && command === 'press' && typeof args.key === 'string' && KEYS[args.key])) return refuse(request);
      keep();
      return { accepted: true };
    },
    async query(request) {
      if (request.capability !== 'applicationLauncher' || request.query !== 'apps') throw new Error(`An Apple TV answers no ${request.capability}.${request.query}`);
      return appsOf(apps);
    },
    close: async () => undefined,
  };
}

export default defineDeviceType<Config>({
  id: 'apple-media.tv',
  kind: 'hardware',
  meta: {
    name: 'Apple TV',
    brand: 'Apple',
    category: 'media-player',
    icon: 'tv',
    description: 'An Apple TV on your home network, as Apple’s own remote reaches it, with no cloud: on and off, play and pause, its remote’s keys, its apps and its volume.',
    support: 'experimental',
    supportNote: 'Ported from pyatv, the library behind Home Assistant’s Apple TV; not yet checked against a real Apple TV.',
  },
  config: { fields: {} },
  describe: () => DESCRIPTION,
  connections: [APPLE_TV_LAN],

  /** Reads it once: verified with what pairing left, and whether it is awake. */
  async identify(connection) {
    const credentials = credentialsOf(connection);
    const link = new CompanionLink(channelOf(connection, 'bytes', 'An Apple TV is reached over TCP'));
    try {
      const session = await CompanionSession.begin(link, credentials);
      const screen = await session.attention();
      await session.end();
      return {
        identity: appleIdentity(credentials),
        model: null,
        summary: `An Apple TV, paired and answering: ${screen === 'asleep' ? 'asleep' : screen === 'unknown' ? 'awake or asleep, it did not say' : 'awake'}.`,
      };
    } catch (error) {
      if (error instanceof PairingRefused) throw new NeedsSignIn(error.message);
      throw error;
    } finally {
      await link.close();
    }
  },

  createSession: (ctx) => realSession(ctx),
  createSimulator: async (ctx) => simulatedSession(ctx),
});
