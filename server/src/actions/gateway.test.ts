import { describe, expect, test } from 'bun:test';

import type { GridRelayProvider, RelayState } from '@kraftverk/plugin-sdk';

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

const station = (gridConnected: boolean, lastUpdated = now()): StationStatus =>
  ({ gridConnected, lastUpdated }) as StationStatus;

type Harness = {
  gateway: ActionGateway;
  relay: StubRelay;
  events: string[];
  setStation: (next: StationStatus | null) => void;
};

function harness(options: { granted?: boolean; provider?: string | null; relay?: StubRelay; readOnly?: boolean } = {}): Harness {
  const relay = options.relay ?? new StubRelay();
  const events: string[] = [];
  let current: StationStatus | null = station(true);

  const host: RelayHost = {
    activeProvider: () => (options.provider === undefined ? 'stub' : options.provider),
    capability: () => relay,
    isGranted: () => options.granted !== false,
  };

  const gateway = new ActionGateway({
    host,
    readStation: () =>
      current ? { status: current } : { status: null, reason: 'No station telemetry' },
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
    const { gateway, setStation, events } = harness();

    const result = await gateway.execute({ desired: false, reason: 'battery first', actor: 'controller' });
    // The stub station still reports mains, so agreement never comes.
    expect(result.outcome).toBe('unverified');
    expect(result.relayReported).toBe(true);
    expect(result.stationAgreed).toBe(false);
    expect(events).toContain('relay.intent');
    expect(events).toContain('relay.unverified');

    setStation(station(false));
    const second = await harness().gateway.execute({ desired: true, reason: 'restore', actor: 'controller' });
    expect(second.outcome).toBe('verified');
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
