import { describe, expect, test } from 'bun:test';

import type { GridRelayProvider, RelayState } from '@kraftverk/device-sdk';

import { ActionGateway, CONFIRMATION_PHRASE, type RelayHost } from './gateway.ts';
import type { StationStatus } from '../types.ts';

/**
 * The guards that stand between a web request and the mains.
 *
 * Every case here is a way the naive version gets it wrong: switching without
 * permission, switching on stale data, switching twice in a second, and — the
 * one that matters most — believing a plug that says "done" while nothing
 * physically moved.
 */

const now = () => new Date().toISOString();

class StubRelay implements GridRelayProvider {
  readonly bootBehaviour = 'last' as const;
  commands: boolean[] = [];

  constructor(
    private state: RelayState = { relayOn: true, reachable: true, updatedAt: now() },
    /** Set when the plug should accept commands but never actually switch. */
    private ignoreCommands = false
  ) {}

  /** Whether mains is physically through, for a station that follows the plug. */
  get on() {
    return this.state.relayOn;
  }

  async read() {
    return this.state;
  }
  async getState() {
    return this.state;
  }
  async setRelay(on: boolean) {
    this.commands.push(on);
    if (!this.ignoreCommands) this.state = { ...this.state, relayOn: on, updatedAt: now() };
    return { accepted: true, readback: this.state, tookMs: 1 };
  }
}

/** One reading, taken when this is called unless told otherwise. */
const station = (
  gridConnected: boolean | null,
  lastUpdated: string | null = now(),
  state: 'connected' | 'offline' = 'connected'
): StationStatus => ({ gridConnected, lastUpdated, link: { state } }) as StationStatus;

/** A station reading live: a fresh reading on every look, of whatever the plug lets through. */
const following = (relay: StubRelay) => () => station(relay.on);

type StationSource = StationStatus | null | (() => StationStatus | null);

type Harness = {
  gateway: ActionGateway;
  relay: StubRelay;
  events: string[];
  setStation: (next: StationSource) => void;
};

function harness(options: { granted?: boolean; provider?: string | null; relay?: StubRelay; readOnly?: boolean } = {}): Harness {
  const relay = options.relay ?? new StubRelay();
  const events: string[] = [];
  // A reading from just now that never changes: fresh enough to act on, but
  // nothing that happens afterwards shows up in it.
  let current: StationSource = station(true);

  const host: RelayHost = {
    activeProvider: () => (options.provider === undefined ? 'stub' : options.provider),
    capability: () => relay,
    isGranted: () => options.granted !== false,
  };

  const gateway = new ActionGateway({
    host,
    readStation: () => {
      const status = typeof current === 'function' ? current() : current;
      return status ? { status } : { status: null, reason: 'No station telemetry' };
    },
    isReadOnly: () => options.readOnly === true,
    record: (entry) => events.push(entry.kind),
    // Short timeouts: these tests are about the decisions, not the clock.
    policy: { verifyTimeoutMs: 300, userDwellMs: 50, controllerDwellMs: 10_000 },
  });

  return { gateway, relay, events, setStation: (next) => (current = next) };
}

describe('permission', () => {
  test('refuses when no plugin owns the relay', async () => {
    const { gateway, relay } = harness({ provider: null });
    const result = await gateway.execute({ desired: false, reason: 'x', actor: 'controller' });

    expect(result.outcome).toBe('refused');
    expect(relay.commands).toHaveLength(0);
  });

  test('refuses without a grant, however well configured the plugin is', async () => {
    const { gateway, relay } = harness({ granted: false });
    const result = await gateway.execute({ desired: false, reason: 'x', actor: 'controller' });

    expect(result.outcome).toBe('refused');
    expect(result.detail).toContain('not been granted');
    expect(relay.commands).toHaveLength(0);
  });

  test('refuses while the server is read-only', async () => {
    const { gateway, relay } = harness({ readOnly: true });
    const result = await gateway.execute({ desired: false, reason: 'x', actor: 'controller' });

    expect(result.outcome).toBe('refused');
    expect(relay.commands).toHaveLength(0);
  });

  test('a person cutting mains must confirm; the controller has its own gates', async () => {
    const { gateway, relay } = harness();

    expect((await gateway.execute({ desired: false, reason: 'x', actor: 'user' })).outcome).toBe('refused');
    expect(relay.commands).toHaveLength(0);

    const confirmed = await gateway.execute({
      desired: false,
      reason: 'x',
      actor: 'user',
      confirmation: CONFIRMATION_PHRASE,
    });
    expect(confirmed.outcome).not.toBe('refused');
    expect(relay.commands).toEqual([false]);
  });
});

describe('freshness', () => {
  test('refuses to switch blind when there is no station telemetry', async () => {
    const { gateway, relay, setStation } = harness();
    setStation(null);

    const result = await gateway.execute({ desired: false, reason: 'x', actor: 'controller' });
    expect(result.outcome).toBe('refused');
    expect(result.detail).toContain('No station telemetry');
    expect(relay.commands).toHaveLength(0);
  });

  /*
    The reason has to survive, not just the refusal. Once a server can hold
    several stations, "no telemetry" and "several, and nobody said which one
    this plug feeds" are different problems with different fixes — and the
    second is the one that would otherwise be papered over by picking a station
    at random, making the whole second proof meaningless.
  */
  test('surfaces why there is no station to verify against', async () => {
    const relay = new StubRelay();
    const events: string[] = [];
    const gateway = new ActionGateway({
      host: { activeProvider: () => 'stub', capability: () => relay, isGranted: () => true },
      readStation: () => ({
        status: null,
        reason: '2 stations are connected and none is recorded as the one this plug feeds',
      }),
      isReadOnly: () => false,
      record: (entry) => events.push(entry.kind),
      policy: { verifyTimeoutMs: 300, userDwellMs: 50, controllerDwellMs: 10_000 },
    });

    const result = await gateway.execute({ desired: false, reason: 'x', actor: 'controller' });

    expect(result.outcome).toBe('refused');
    expect(result.detail).toContain('none is recorded as the one this plug feeds');
    expect(relay.commands).toHaveLength(0);
  });

  test('refuses on stale station telemetry', async () => {
    const { gateway, relay, setStation } = harness();
    setStation(station(true, new Date(Date.now() - 10 * 60_000).toISOString()));

    const result = await gateway.execute({ desired: false, reason: 'x', actor: 'controller' });
    expect(result.outcome).toBe('refused');
    expect(result.detail).toContain('stale');
    expect(relay.commands).toHaveLength(0);
  });

  test('refuses when the station has never sent a reading, or is not connected', async () => {
    for (const silent of [station(null, null, 'offline'), station(null, null), station(true, now(), 'offline')]) {
      const { gateway, relay, setStation } = harness();
      setStation(silent);
      const result = await gateway.execute({ desired: false, reason: 'x', actor: 'controller' });
      expect(result.outcome).toBe('refused');
      expect(result.detail).toContain('not answering');
      expect(relay.commands).toHaveLength(0);
    }
  });

  test('refuses when the plug itself is not answering', async () => {
    const relay = new StubRelay({ relayOn: true, reachable: false, updatedAt: now() });
    const { gateway } = harness({ relay });

    const result = await gateway.execute({ desired: false, reason: 'x', actor: 'controller' });
    expect(result.outcome).toBe('refused');
    expect(relay.commands).toHaveLength(0);
  });
});

describe('verification', () => {
  test('verified needs both the plug and the station to agree', async () => {
    const { gateway, events } = harness();

    const result = await gateway.execute({ desired: false, reason: 'battery first', actor: 'controller' });
    // The station reports nothing new after the switch, so agreement never comes.
    expect(result.outcome).toBe('unverified');
    expect(result.relayReported).toBe(true);
    expect(result.stationAgreed).toBe(false);
    expect(events).toContain('relay.intent');
    expect(events).toContain('relay.unverified');

    const live = harness();
    live.setStation(following(live.relay));
    const second = await live.gateway.execute({ desired: false, reason: 'battery first', actor: 'controller' });
    expect(second.outcome).toBe('verified');
    expect(second.stationAgreed).toBe(true);
  });

  /*
    The audit's case: a station whose last reading already said "no mains" —
    cached from before the switch, and never updated since. It agreed with
    "mains off" before anything had happened, and that was reported as proof.
  */
  test('only a reading taken after the switch counts as the station agreeing', async () => {
    const { gateway, setStation } = harness();
    setStation(station(false)); // fresh, but from before the switch, and never again

    const result = await gateway.execute({ desired: false, reason: 'x', actor: 'controller' });
    expect(result.outcome).toBe('unverified');
    expect(result.stationAgreed).toBe(false);
  });

  test('a plug that accepts commands but never switches is caught', async () => {
    // The failure a naive gateway misses entirely: "accepted" is not "switched".
    const relay = new StubRelay({ relayOn: true, reachable: true, updatedAt: now() }, true);
    const { gateway } = harness({ relay });

    const result = await gateway.execute({ desired: false, reason: 'x', actor: 'controller' });

    expect(relay.commands).toEqual([false]);
    expect(result.outcome).toBe('unverified');
    expect(result.relayReported).toBe(false);
  });

  test('an already-correct state is not switched again', async () => {
    const { gateway, relay } = harness();
    const result = await gateway.execute({ desired: true, reason: 'x', actor: 'controller' });

    expect(result.outcome).toBe('verified');
    expect(relay.commands).toHaveLength(0);
  });

  test('an already-correct plug the station disagrees with is not called verified', async () => {
    const { gateway, relay, setStation } = harness();
    setStation(station(false)); // the plug says on; the station sees no mains
    const result = await gateway.execute({ desired: true, reason: 'x', actor: 'controller' });

    expect(result.outcome).toBe('unverified');
    expect(result.stationAgreed).toBe(false);
    expect(relay.commands).toHaveLength(0);
  });
});

describe('dwell', () => {
  test('a second command inside the dwell window is refused, not queued', async () => {
    const { gateway, relay } = harness();

    await gateway.execute({ desired: false, reason: 'first', actor: 'controller' });
    const second = await gateway.execute({ desired: true, reason: 'immediately after', actor: 'controller' });

    expect(second.outcome).toBe('refused');
    expect(second.detail).toContain('Too soon');
    // One command reached the plug: no relay chatter.
    expect(relay.commands).toEqual([false]);
  });

  /*
    The dwell check reads a timestamp that is only written several awaits later,
    at step 6. Two requests arriving together therefore both look, both see the
    window clear, and both send — which is the one thing this class promises
    never to do. Sequentially it is impossible, which is why it survived.
  */
  test('each plug has its own dwell time, and it survives a restart', async () => {
    const kept = new Map<string, string>();
    const memory = { get: (key: string) => kept.get(key) ?? null, set: (key: string, value: string) => void kept.set(key, value) };
    const plugs: Record<string, StubRelay> = { a: new StubRelay(), b: new StubRelay() };
    let active = 'a';
    const gateway = () =>
      new ActionGateway({
        host: { activeProvider: () => active, capability: (id) => plugs[id]!, isGranted: () => true },
        readStation: () => ({ status: station(true) }),
        isReadOnly: () => false,
        record: () => {},
        memory,
        policy: { verifyTimeoutMs: 50, userDwellMs: 50, controllerDwellMs: 10_000 },
      });

    await gateway().execute({ desired: false, reason: 'a', actor: 'controller' });
    expect(plugs.a!.commands).toEqual([false]);

    // A new process, the same database: still too soon for plug a.
    const restarted = await gateway().execute({ desired: true, reason: 'again', actor: 'controller' });
    expect(restarted.detail).toContain('Too soon');

    // Plug b has its own clock.
    active = 'b';
    await gateway().execute({ desired: false, reason: 'b', actor: 'controller' });
    expect(plugs.b!.commands).toEqual([false]);
  });

  test('two commands arriving at once still send exactly one', async () => {
    const { gateway, relay } = harness();

    const [first, second] = await Promise.all([
      gateway.execute({ desired: false, reason: 'a', actor: 'controller' }),
      gateway.execute({ desired: false, reason: 'b', actor: 'controller' }),
    ]);

    expect(relay.commands).toHaveLength(1);
    // The loser is told why rather than silently duplicating the winner. The
    // winner's own outcome depends on whether the station agrees, which is a
    // different test's subject.
    const refused = [first, second].filter((r) => r.outcome === 'refused');
    expect(refused).toHaveLength(1);
    expect(refused[0]!.detail).toContain('Too soon');
  });
});
