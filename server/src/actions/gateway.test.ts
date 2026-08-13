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
    readStation: () => current,
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
});
