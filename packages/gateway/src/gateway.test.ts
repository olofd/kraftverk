import { describe, expect, test } from 'bun:test';

import { savedDeviceId, type CommandResult, type ConnectionHealth, type DeviceSession, type SavedDeviceId } from '@kraftverk/device-sdk';

import { ActionGateway, CONFIRMATION, type CommandIntent, type GatewayDevice } from './gateway.ts';

/**
 * The guards that stand between a web request and the hardware.
 *
 * Every case here is a way the naive version gets it wrong: switching while
 * read-only, switching on stale data, switching twice in a second, and — the
 * one that matters most — believing a plug that says "done" while nothing
 * physically moved. The gateway knows no product: a plug is any session with
 * `switch`, a station any session with `acInput`, and which plug feeds which
 * station is a link.
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

/** A plug: `switch` and `powerMeter`. */
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
      readings: () => [],
      capability: ((name: string) => {
        if (name === 'switch') {
          return {
            state: () => (this.on === null || this.at === null ? null : { on: this.on, at: this.at }),
            set: async (on: boolean): Promise<CommandResult> => {
              this.commands.push(on);
              if (!this.ignoreCommands) {
                this.on = on;
                this.at = now();
              }
              return { accepted: true };
            },
            bootBehaviour: () => 'last',
          };
        }
        if (name === 'powerMeter') return { read: () => ({ watts: this.watts, at: now() }) };
        return null;
      }) as DeviceSession['capability'],
      close: async () => {},
    };
  }
}

type StationReading = { present: boolean | null; at: string | null; connected: boolean } | null;

/** A station: `acInput`, and outlets it can switch itself. */
class StubStation {
  reading: StationReading | (() => StationReading) = { present: true, at: now(), connected: true };
  outlets = [{ id: 'ac', label: 'AC', on: true as boolean | null, watts: 40 as number | null }];
  outletCommands: [string, boolean][] = [];

  #current(): StationReading {
    return typeof this.reading === 'function' ? this.reading() : this.reading;
  }

  session(): DeviceSession {
    return {
      health: () => health(this.#current()?.connected ?? false),
      readings: () => [],
      capability: ((name: string) => {
        if (name === 'acInput') {
          return {
            read: () => {
              const reading = this.#current();
              return reading?.at ? { present: reading.present, watts: null, at: reading.at } : null;
            },
          };
        }
        if (name === 'outlets') {
          return {
            read: () => ({ outlets: this.outlets, at: now() }),
            set: async (id: string, on: boolean): Promise<CommandResult> => {
              this.outletCommands.push([id, on]);
              this.outlets = this.outlets.map((outlet) => (outlet.id === id ? { ...outlet, on } : outlet));
              return { accepted: true };
            },
          };
        }
        return null;
      }) as DeviceSession['capability'],
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
  options: { plug?: StubPlug; readOnly?: boolean; feeds?: boolean; stationSession?: boolean; memory?: GatewayMemory; everSwitched?: boolean } = {}
): Harness {
  const plug = options.plug ?? new StubPlug();
  const station = new StubStation();
  const events: string[] = [];
  const plugSession = plug.session();
  const stationSession = station.session();
  const memory = options.memory ?? inMemory();
  // Most cases are about a plug that has been switched before; the first switch has its own test.
  if (options.everSwitched !== false) memory.set(`gateway.everSwitched.${PLUG}`, '1');

  const devices: Record<string, GatewayDevice> = {
    [PLUG]: { name: 'Heater plug', session: plugSession, offline: 'Not answering' },
    [STATION]: { name: 'Garage P280', session: options.stationSession === false ? null : stationSession, offline: 'Not answering' },
  };
  const gateway = new ActionGateway({
    device: (id) => devices[id] ?? null,
    feeds: (id) => (options.feeds !== false && id === PLUG ? STATION : null),
    isReadOnly: () => options.readOnly === true,
    record: (entry) => events.push(entry.kind),
    memory,
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
  capability: 'switch',
  command: 'set',
  value: false,
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

  test('refuses a capability the device does not offer', async () => {
    const { gateway } = harness();
    const result = await gateway.execute(cut({ capability: 'outlets', target: 'ac' }));
    expect(result.outcome).toBe('refused');
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

    expect((await gateway.execute(cut({ actor: 'user', by: 'olof' }))).outcome).toBe('refused');
    expect(plug.commands).toHaveLength(0);

    const confirmed = await gateway.execute(cut({ actor: 'user', by: 'olof', confirmation: CONFIRMATION }));
    expect(confirmed.outcome).not.toBe('refused');
    expect(plug.commands).toEqual([false]);
  });

  test('the first switch of a plug that feeds a station needs confirmation, even to turn it on', async () => {
    const plug = new StubPlug({ on: false });
    const { gateway } = harness({ plug, everSwitched: false });
    const result = await gateway.execute(cut({ actor: 'user', by: 'olof', value: true }));
    expect(result.outcome).toBe('refused');
    expect(result.detail).toContain('confirmation');
  });

  test('turning off an outlet carrying a load needs confirmation; one carrying nothing does not', async () => {
    const { gateway, station } = harness();
    const intent = cut({ deviceId: STATION, capability: 'outlets', target: 'ac', actor: 'user', by: 'olof' });

    expect((await gateway.execute(intent)).outcome).toBe('refused');
    station.outlets = [{ id: 'ac', label: 'AC', on: true, watts: 0 }];
    const idle = await gateway.execute(intent);
    expect(idle.outcome).toBe('verified');
    expect(station.outletCommands).toEqual([['ac', false]]);
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
    expect(result.stationAgreed).toBeUndefined();
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
    expect(result.stationAgreed).toBe(false);
    expect(events).toContain('command.intent');
    expect(events).toContain('command.unverified');

    const live = harness();
    live.follow();
    const second = await live.gateway.execute(cut());
    expect(second.outcome).toBe('verified');
    expect(second.stationAgreed).toBe(true);
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
    expect(result.stationAgreed).toBe(false);
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
    const result = await gateway.execute(cut({ value: true }));
    expect(result.outcome).toBe('verified');
    expect(plug.commands).toHaveLength(0);
  });

  test('an already-correct plug the station disagrees with is not called verified', async () => {
    const { gateway, plug, station } = harness();
    station.reading = { present: false, at: now(), connected: true }; // the plug says on; the station sees no mains
    const result = await gateway.execute(cut({ value: true }));
    expect(result.outcome).toBe('unverified');
    expect(result.stationAgreed).toBe(false);
    expect(plug.commands).toHaveLength(0);
  });
});

describe('dwell', () => {
  test('a second command inside the dwell window is refused, not queued', async () => {
    const { gateway, plug } = harness();

    await gateway.execute(cut({ reason: 'first' }));
    const second = await gateway.execute(cut({ value: true, reason: 'immediately after' }));

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
    expect((await restarted.gateway.execute(cut({ value: true }))).detail).toContain('Too soon');

    // The station's outlet has a clock of its own.
    restarted.station.outlets = [{ id: 'ac', label: 'AC', on: true, watts: 0 }];
    const outlet = await restarted.gateway.execute(cut({ deviceId: STATION, capability: 'outlets', target: 'ac' }));
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
