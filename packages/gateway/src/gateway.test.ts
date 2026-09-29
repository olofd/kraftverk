import { describe, expect, test } from 'bun:test';

import { MAIN_PART, savedDeviceId, type CommandResult, type ConnectionHealth, type DeviceDescription, type DeviceSession, type PolicyValues, type SavedDeviceId } from '@kraftverk/device-sdk';

import { ActionGateway, type CommandIntent, type GatewayDevice, type OutgoingLink } from './gateway.ts';

/**
 * The guards that stand between a web request and the hardware.
 *
 * Every case here is a way the naive version gets it wrong: switching while
 * read-only, switching on stale data, switching twice in a second, and — the
 * one that matters most — believing a plug that says "done" while nothing
 * physically moved. The gateway knows no product: a plug is any device whose
 * part offers `switch`, a station any device with a part offering `acInput`,
 * and which plug feeds which station is a link.
 */

const now = () => new Date().toISOString();
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

const health = (connected = true): ConnectionHealth => ({
  status: connected ? 'connected' : 'offline',
  detail: connected ? 'Connected' : 'Not answering',
  owner: 'server',
  transport: 'test',
  lastReadingAt: now(),
});

/** A plug: one part, with `switch` and `powerMeter`. */
const PLUG_DESCRIPTION: DeviceDescription = {
  parts: [{ id: MAIN_PART, label: 'Plug', kind: 'outlet', offers: ['switch'] }],
  attributes: [
    { key: 'relay', label: 'Relay', value: { type: 'boolean' }, means: 'switch.on' },
    { key: 'watts', label: 'Power', value: { type: 'number', unit: 'W' }, quantity: 'power', means: 'power.draw' },
  ],
};

class StubPlug {
  commands: boolean[] = [];
  on: boolean | null;
  at: string | null;
  watts = 0;

  constructor(
    initial: { on?: boolean | null; at?: string | null } = {},
    /** Accepts commands but never actually switches. */
    private ignoreCommands = false
  ) {
    this.on = initial.on === undefined ? true : initial.on;
    this.at = initial.at === undefined ? now() : initial.at;
  }

  session(): DeviceSession {
    return {
      health: () => health(),
      readings: () => (this.at === null ? [] : [{ key: 'relay', value: this.on, at: this.at }, { key: 'watts', value: this.watts, at: this.at }]),
      command: async (request): Promise<CommandResult> => {
        const on = request.args.on as boolean;
        this.commands.push(on);
        if (!this.ignoreCommands) {
          this.on = on;
          this.at = now();
        }
        return { accepted: true };
      },
      close: async () => {},
    };
  }
}

type StationReading = { present: boolean | null; at: string | null; connected: boolean } | null;

/** A station: its mains an input part with `acInput`, and an outlet part it switches itself. */
const STATION_DESCRIPTION: DeviceDescription = {
  parts: [
    { id: MAIN_PART, label: 'Station', kind: 'device' },
    { id: 'input.ac', label: 'Mains', kind: 'input' },
    { id: 'outlet.ac', label: 'AC outlets', kind: 'outlet', offers: ['switch'] },
  ],
  attributes: [
    { key: 'input.ac.present', part: 'input.ac', label: 'Mains present', value: { type: 'boolean' }, means: 'grid.present' },
    { key: 'outlet.ac.on', part: 'outlet.ac', label: 'AC outlets', value: { type: 'boolean' }, means: 'switch.on' },
    { key: 'outlet.ac.watts', part: 'outlet.ac', label: 'AC draw', value: { type: 'number', unit: 'W' }, quantity: 'power', means: 'power.draw' },
  ],
};

class StubStation {
  reading: StationReading | (() => StationReading) = { present: true, at: now(), connected: true };
  outlet = { on: true as boolean | null, watts: 40 as number | null };
  outletCommands: [string, boolean][] = [];

  #current(): StationReading {
    return typeof this.reading === 'function' ? this.reading() : this.reading;
  }

  session(): DeviceSession {
    return {
      health: () => health(this.#current()?.connected ?? false),
      readings: () => {
        const reading = this.#current();
        return [
          ...(reading?.at ? [{ key: 'input.ac.present', value: reading.present, at: reading.at }] : []),
          { key: 'outlet.ac.on', value: this.outlet.on, at: now() },
          { key: 'outlet.ac.watts', value: this.outlet.watts, at: now() },
        ];
      },
      command: async (request): Promise<CommandResult> => {
        const on = request.args.on as boolean;
        this.outletCommands.push([request.part, on]);
        this.outlet = { ...this.outlet, on };
        return { accepted: true };
      },
      close: async () => {},
    };
  }
}

const PLUG = savedDeviceId('d-plug');
const STATION = savedDeviceId('d-station');

type Harness = {
  gateway: ActionGateway;
  plug: StubPlug;
  station: StubStation;
  events: string[];
  /** The station follows the plug, as one fed by it does: a fresh reading of whatever the plug lets through. */
  follow(): void;
};

function harness(
  options: {
    plug?: StubPlug;
    readOnly?: boolean;
    feeds?: boolean;
    stationSession?: boolean;
    memory?: GatewayMemory;
    everSwitched?: boolean;
    /** More links, from a part: `{ '<device>:<part>': [target, part] }`. */
    links?: Record<string, OutgoingLink[]>;
    devices?: Record<string, GatewayDevice>;
    policyValues?: PolicyValues;
  } = {}
): Harness {
  const plug = options.plug ?? new StubPlug();
  const station = new StubStation();
  const events: string[] = [];
  const plugSession = plug.session();
  const stationSession = station.session();
  const memory = options.memory ?? inMemory();
  // Most cases are about a plug that has been switched before; the first switch has its own test.
  if (options.everSwitched !== false) memory.set(`gateway.everSwitched.${PLUG}:${MAIN_PART}`, '1');

  const devices: Record<string, GatewayDevice> = {
    [PLUG]: { name: 'Heater plug', session: plugSession, description: PLUG_DESCRIPTION, offline: 'Not answering' },
    [STATION]: { name: 'Garage P280', session: options.stationSession === false ? null : stationSession, description: STATION_DESCRIPTION, offline: 'Not answering' },
    ...options.devices,
  };
  const links: Record<string, OutgoingLink[]> = {
    ...(options.feeds !== false ? { [`${PLUG}:${MAIN_PART}`]: [{ kind: 'feeds', target: { device: STATION, part: 'input.ac' } }] } : {}),
    ...options.links,
  };
  const gateway = new ActionGateway({
    device: (id) => devices[id] ?? null,
    linksFrom: (id, part) => links[`${id}:${part}`] ?? [],
    isReadOnly: () => options.readOnly === true,
    record: (entry) => events.push(entry.kind),
    memory,
    policyValues: () => options.policyValues ?? {},
    // Short timeouts: these tests are about the decisions, not the clock.
    policy: { verifyTimeoutMs: 300, userDwellMs: 50, automationDwellMs: 10_000 },
  });
  return {
    gateway,
    plug,
    station,
    events,
    follow: () => {
      station.reading = () => ({ present: plug.on, at: now(), connected: true });
    },
  };
}

type GatewayMemory = { get(key: string): string | null; set(key: string, value: string): void };
const inMemory = (): GatewayMemory => {
  const kept = new Map<string, string>();
  return { get: (key) => kept.get(key) ?? null, set: (key, value) => void kept.set(key, value) };
};

const cut = (overrides: Partial<CommandIntent> = {}): CommandIntent => ({
  deviceId: PLUG,
  part: MAIN_PART,
  capability: 'switch',
  command: 'set',
  args: { on: false },
  reason: 'battery first',
  actor: 'automation',
  by: 'automation:test',
  ...overrides,
});

describe('what may be commanded', () => {
  test('refuses a device that is not there', async () => {
    const { gateway } = harness();
    const result = await gateway.execute(cut({ deviceId: savedDeviceId('d-nope') as SavedDeviceId }));
    expect(result).toEqual({ outcome: 'refused', detail: 'No such device' });
  });

  test('refuses a command its capability does not have', async () => {
    const { gateway, plug } = harness();
    const result = await gateway.execute(cut({ command: 'explode' }));
    expect(result.outcome).toBe('refused');
    expect(plug.commands).toHaveLength(0);
  });

  test('refuses a part that does not offer the capability', async () => {
    const { gateway, station } = harness();
    const result = await gateway.execute(cut({ deviceId: STATION, part: 'input.ac' }));
    expect(result).toEqual({ outcome: 'refused', detail: '"input.ac" does not offer switch' });
    expect(station.outletCommands).toHaveLength(0);
  });

  test('refuses arguments the command does not take, or of the wrong type', async () => {
    const { gateway, plug } = harness();
    expect((await gateway.execute(cut({ args: { on: 'yes' } }))).detail).toBe('on must be true or false');
    expect((await gateway.execute(cut({ args: { on: false, speed: 3 } }))).detail).toBe('switch.set takes no speed');
    expect(plug.commands).toHaveLength(0);
  });

  test('refuses while the server is read-only', async () => {
    const { gateway, plug } = harness({ readOnly: true });
    const result = await gateway.execute(cut());
    expect(result.outcome).toBe('refused');
    expect(result.detail).toContain('read-only');
    expect(plug.commands).toHaveLength(0);
  });

  test('a person cutting mains must confirm; an automation has its own gates', async () => {
    const { gateway, plug } = harness();

    const asked = await gateway.execute(cut({ actor: 'user', by: 'olof' }));
    expect(asked.outcome).toBe('refused');
    expect(plug.commands).toHaveLength(0);

    const confirmed = await gateway.execute(cut({ actor: 'user', by: 'olof', confirmation: asked.needsConfirmation }));
    expect(confirmed.outcome).not.toBe('refused');
    expect(plug.commands).toEqual([false]);
  });

  test('a confirmation is a token for this intent and this person, good once — not a word anyone can send', async () => {
    const { gateway, plug, station } = harness();
    station.reading = () => ({ present: true, at: now(), connected: true });

    // The constant that used to be enough is no yes at all.
    expect(await gateway.execute(cut({ actor: 'user', by: 'olof', confirmation: 'confirm' }))).toMatchObject({ outcome: 'refused', needsConfirmation: expect.any(String) });

    const asked = await gateway.execute(cut({ actor: 'user', by: 'olof' }));
    // Someone else presenting it, or it presented for another command, is refused, and it is spent.
    expect((await gateway.execute(cut({ actor: 'user', by: 'guest', confirmation: asked.needsConfirmation }))).outcome).toBe('refused');
    expect((await gateway.execute(cut({ actor: 'user', by: 'olof', confirmation: asked.needsConfirmation }))).outcome).toBe('refused');
    const again = await gateway.execute(cut({ actor: 'user', by: 'olof', args: { on: true } }));
    expect((await gateway.execute(cut({ actor: 'user', by: 'olof', confirmation: again.needsConfirmation }))).outcome).toBe('refused');
    expect(plug.commands).toHaveLength(0);
  });

  test('the first switch of a plug that feeds a station needs confirmation, even to turn it on', async () => {
    const plug = new StubPlug({ on: false });
    const { gateway } = harness({ plug, everSwitched: false });
    const result = await gateway.execute(cut({ actor: 'user', by: 'olof', args: { on: true } }));
    expect(result.outcome).toBe('refused');
    expect(result.detail).toContain('confirmation');
  });

  test('turning off an outlet carrying a load needs confirmation; one carrying nothing does not', async () => {
    const { gateway, station } = harness();
    const intent = cut({ deviceId: STATION, part: 'outlet.ac', actor: 'user', by: 'olof' });

    // As `switch.set` declares it: off, while it draws more than 5 W. The gateway reads the declaration.
    expect(await gateway.execute(intent)).toMatchObject({ outcome: 'refused', needsConfirmation: expect.any(String), detail: 'This action needs explicit confirmation. Power is 40 W.' });
    station.outlet = { on: true, watts: 0 };
    const idle = await gateway.execute(intent);
    expect(idle.outcome).toBe('verified');
    expect(station.outletCommands).toEqual([['outlet.ac', false]]);
  });

  test('a load that is not known is not taken for none: it asks', async () => {
    const { gateway, station } = harness();
    station.outlet = { on: true, watts: null };
    const intent = cut({ deviceId: STATION, part: 'outlet.ac', actor: 'user', by: 'olof' });
    expect(await gateway.execute(intent)).toMatchObject({ outcome: 'refused', needsConfirmation: expect.any(String), detail: 'This action needs explicit confirmation. Power is not known.' });
    expect(station.outletCommands).toHaveLength(0);
  });

  test('how much is a load is the home’s to say', async () => {
    // A night light at 6 W: over the default, under what this home has set.
    const { gateway, station } = harness({ policyValues: { loadWatts: 10 } });
    station.outlet = { on: true, watts: 6 };
    expect((await gateway.execute(cut({ deviceId: STATION, part: 'outlet.ac', actor: 'user', by: 'olof' }))).outcome).toBe('verified');

    const strict = harness({ policyValues: { loadWatts: 3 } });
    strict.station.outlet = { on: true, watts: 4 };
    expect(await strict.gateway.execute(cut({ deviceId: STATION, part: 'outlet.ac', actor: 'user', by: 'olof' }))).toMatchObject({ detail: 'This action needs explicit confirmation. Power is 4 W.' });
  });
});

describe('links between parts', () => {
  /*
    A station's AC outlet feeds another station's mains input: the link joins
    parts, and the gateway walks it like any other — confirming the cut, and
    holding the outlet's switch to the other station's own reading of mains.
  */
  const OTHER = savedDeviceId('d-other');

  function chain() {
    const other = new StubStation();
    const setup = harness({
      feeds: false,
      devices: { [OTHER]: { name: 'Cabin station', session: other.session(), description: STATION_DESCRIPTION, offline: 'Not answering' } },
      links: { [`${STATION}:outlet.ac`]: [{ kind: 'feeds', target: { device: OTHER, part: 'input.ac' } }] },
    });
    setup.station.outlet = { on: true, watts: 0 };
    return { ...setup, other };
  }

  test('cutting what a station’s outlet feeds is confirmed, naming the part it reaches', async () => {
    const { gateway, station } = chain();
    const result = await gateway.execute(cut({ deviceId: STATION, part: 'outlet.ac', actor: 'user', by: 'olof' }));
    expect(result).toMatchObject({ outcome: 'refused', needsConfirmation: expect.any(String) });
    expect(result.detail).toContain('This feeds Cabin station — Mains and has never been switched from here');
    expect(station.outletCommands).toHaveLength(0);
  });

  test('and is verified by the station it feeds seeing its mains go', async () => {
    const { gateway, station, other } = chain();
    other.reading = () => ({ present: station.outlet.on, at: now(), connected: true });
    const result = await gateway.execute(cut({ deviceId: STATION, part: 'outlet.ac' }));
    expect(result).toMatchObject({ outcome: 'verified', deviceAgreed: true, linkAgreed: true });
    expect(result.detail).toContain('Cabin station — Mains (mains present: off)');
  });

  test('a link to a part that no longer offers what the kind reaches is not answering', async () => {
    const { gateway, station } = chain();
    const result = await gateway.execute(cut({ deviceId: STATION, part: 'outlet.ac' }));
    expect(result.outcome).not.toBe('refused');
    expect(station.outletCommands).toEqual([['outlet.ac', false]]);
    const wrong = harness({ feeds: false, links: { [`${PLUG}:${MAIN_PART}`]: [{ kind: 'feeds', target: { device: STATION, part: 'outlet.ac' } }] } });
    expect((await wrong.gateway.execute(cut())).detail).toContain('is not answering');
  });
});

describe('what a command declares', () => {
  /*
    A capability of a package's own, in the library's shape: the gateway takes
    it from the description and needs no edit for it — its consequence included.
  */
  const LOCK = savedDeviceId('d-lock');
  const LOCK_DESCRIPTION: DeviceDescription = {
    capabilities: {
      'acme.safe.bolt': {
        label: 'Bolt',
        attributes: { thrown: { means: 'switch.on', required: true } },
        commands: { set: { description: 'Throw or draw the bolt', args: { thrown: { type: 'boolean' } }, sets: { thrown: 'thrown' }, consequential: 'always' } },
        queries: {},
      },
    },
    parts: [{ id: MAIN_PART, label: 'Safe', kind: 'lock', offers: ['acme.safe.bolt'] }],
    attributes: [{ key: 'bolt', label: 'Bolt', value: { type: 'boolean' }, means: 'switch.on' }],
  };

  test('a package’s own capability is commanded like any other, and "always" means every time', async () => {
    let thrown = false;
    const session: DeviceSession = {
      health: () => health(true),
      readings: () => [{ key: 'bolt', value: thrown, at: now() }],
      command: async (request) => {
        thrown = request.args.thrown as boolean;
        return { accepted: true };
      },
      close: async () => {},
    };
    const { gateway } = harness({ devices: { [LOCK]: { name: 'Safe', session, description: LOCK_DESCRIPTION, offline: 'Not answering' } } });
    const intent = cut({ deviceId: LOCK, capability: 'acme.safe.bolt', command: 'set', args: { thrown: true }, actor: 'user', by: 'olof' });
    const asked = await gateway.execute(intent);
    // Read before matching: bun's toMatchObject writes its matchers into what it was given.
    const token = asked.needsConfirmation;
    expect(asked).toMatchObject({ outcome: 'refused', needsConfirmation: expect.any(String) });
    expect(await gateway.execute({ ...intent, confirmation: token })).toMatchObject({ outcome: 'verified' });
    expect(thrown).toBe(true);
  });
});

describe('freshness', () => {
  test('refuses when the plug itself has not said what it is doing', async () => {
    const plug = new StubPlug({ on: null, at: null });
    const { gateway } = harness({ plug });
    const result = await gateway.execute(cut());
    expect(result.outcome).toBe('refused');
    expect(plug.commands).toHaveLength(0);
  });

  test('refuses on a stale reading from the plug', async () => {
    const plug = new StubPlug({ at: ago(10 * 60_000) });
    const { gateway } = harness({ plug });
    const result = await gateway.execute(cut());
    expect(result.detail).toContain('stale');
    expect(plug.commands).toHaveLength(0);
  });

  test('refuses to switch a feeding plug blind when the station it feeds is not there', async () => {
    const { gateway, plug } = harness({ stationSession: false });
    const result = await gateway.execute(cut());
    expect(result.outcome).toBe('refused');
    expect(result.detail).toContain('not answering');
    expect(plug.commands).toHaveLength(0);
  });

  test('refuses on stale station telemetry', async () => {
    const { gateway, plug, station } = harness();
    station.reading = { present: true, at: ago(10 * 60_000), connected: true };
    const result = await gateway.execute(cut());
    expect(result.detail).toContain('stale');
    expect(plug.commands).toHaveLength(0);
  });

  test('refuses when the station has never sent a reading, or is not connected', async () => {
    for (const silent of [null, { present: null, at: null, connected: true }, { present: true, at: now(), connected: false }]) {
      const { gateway, plug, station } = harness();
      station.reading = silent;
      const result = await gateway.execute(cut());
      expect(result.outcome).toBe('refused');
      expect(result.detail).toContain('not answering');
      expect(plug.commands).toHaveLength(0);
    }
  });

  test('a plug that feeds nothing is verified by its own readback alone', async () => {
    const { gateway, plug } = harness({ feeds: false });
    const result = await gateway.execute(cut());
    expect(result.outcome).toBe('verified');
    expect(result.linkAgreed).toBeUndefined();
    expect(plug.commands).toEqual([false]);
  });
});

describe('verification', () => {
  test('verified needs both the plug and the station it feeds to agree', async () => {
    const { gateway, events } = harness();

    const result = await gateway.execute(cut());
    // The station reports nothing new after the switch, so agreement never comes.
    expect(result.outcome).toBe('unverified');
    expect(result.deviceAgreed).toBe(true);
    expect(result.linkAgreed).toBe(false);
    expect(events).toContain('command.intent');
    expect(events).toContain('command.unverified');

    const live = harness();
    live.follow();
    const second = await live.gateway.execute(cut());
    expect(second.outcome).toBe('verified');
    expect(second.linkAgreed).toBe(true);
  });

  /*
    The audit's case: a station whose last reading already said "no mains" —
    cached from before the switch, and never updated since. It agreed with
    "mains off" before anything had happened, and that was reported as proof.
  */
  test('only a reading taken after the switch counts as the station agreeing', async () => {
    const { gateway, station } = harness();
    station.reading = { present: false, at: now(), connected: true }; // fresh, but from before the switch, and never again

    const result = await gateway.execute(cut());
    expect(result.outcome).toBe('unverified');
    expect(result.linkAgreed).toBe(false);
  });

  test('a plug that accepts commands but never switches is caught', async () => {
    // The failure a naive gateway misses entirely: "accepted" is not "switched".
    const plug = new StubPlug({}, true);
    const { gateway } = harness({ plug });

    const result = await gateway.execute(cut());
    expect(plug.commands).toEqual([false]);
    expect(result.outcome).toBe('unverified');
    expect(result.deviceAgreed).toBe(false);
  });

  test('an already-correct state is not switched again', async () => {
    const { gateway, plug } = harness();
    const result = await gateway.execute(cut({ args: { on: true } }));
    expect(result.outcome).toBe('verified');
    expect(plug.commands).toHaveLength(0);
  });

  test('an already-correct plug the station disagrees with is not called verified', async () => {
    const { gateway, plug, station } = harness();
    station.reading = { present: false, at: now(), connected: true }; // the plug says on; the station sees no mains
    const result = await gateway.execute(cut({ args: { on: true } }));
    expect(result.outcome).toBe('unverified');
    expect(result.linkAgreed).toBe(false);
    expect(plug.commands).toHaveLength(0);
  });
});

describe('dwell', () => {
  test('a second command inside the dwell window is refused, not queued', async () => {
    const { gateway, plug } = harness();

    await gateway.execute(cut({ reason: 'first' }));
    const second = await gateway.execute(cut({ args: { on: true }, reason: 'immediately after' }));

    expect(second.outcome).toBe('refused');
    expect(second.detail).toContain('Too soon');
    // One command reached the plug: no relay chatter.
    expect(plug.commands).toEqual([false]);
  });

  test('each device has its own dwell time, and it survives a restart', async () => {
    const memory = inMemory();
    const first = harness({ memory });
    await first.gateway.execute(cut());
    expect(first.plug.commands).toEqual([false]);

    // A new process, the same database: still too soon for this plug.
    const restarted = harness({ memory });
    expect((await restarted.gateway.execute(cut({ args: { on: true } }))).detail).toContain('Too soon');

    // The station's outlet has a clock of its own.
    restarted.station.outlet = { on: true, watts: 0 };
    const outlet = await restarted.gateway.execute(cut({ deviceId: STATION, part: 'outlet.ac' }));
    expect(outlet.outcome).toBe('verified');
  });

  /*
    The dwell check reads a timestamp that is only written several awaits later.
    Two requests arriving together therefore both looked, both saw the window
    clear, and both sent — the one thing this class promises never to do.
  */
  test('two commands arriving at once still send exactly one', async () => {
    const { gateway, plug } = harness();

    const [first, second] = await Promise.all([gateway.execute(cut({ reason: 'a' })), gateway.execute(cut({ reason: 'b' }))]);

    expect(plug.commands).toHaveLength(1);
    // The loser is told why rather than silently duplicating the winner.
    const refused = [first, second].filter((result) => result.outcome === 'refused');
    expect(refused).toHaveLength(1);
    expect(refused[0]!.detail).toContain('Too soon');
  });
});
