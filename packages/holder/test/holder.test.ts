import { describe, expect, test } from 'bun:test';

import type { ConnectionView } from '@kraftverk/api-contract';
import { clientId, connectionId, savedDeviceId, type DeviceSession, type DeviceType, type Protocol, type Transport } from '@kraftverk/device-sdk';
import { fakeByteChannel } from '@kraftverk/device-sdk/testing';

import { activeConnection, Failover, identityVerdict, judgeCheck, openDevice, OpenRefused, toHold, withInUse } from '../src/index.ts';

/*
  The holder core: what the server and the app both do with a device they
  hold. Each rule here used to be written twice, and had drifted.
*/

const quiet = { info: () => {}, warn: () => {}, error: () => {} };
const session = (extra: Partial<DeviceSession> = {}): DeviceSession => ({
  health: () => ({ status: 'connected', detail: 'Fine', lastReadingAt: null }),
  readings: () => [],
  command: async () => ({ accepted: false, error: 'A lamp takes no commands here' }),
  close: async () => {},
  ...extra,
});

/** A protocol that refuses frames starting with zero, as a real guard refuses a dangerous write. */
const protocol: Protocol = { id: 'lampish', label: 'Lampish', bindings: { bus: { open: () => ({}), recognise: () => null } }, guard: (bytes) => (bytes[0] === 0 ? 'Refused: zero' : null) };

function lampType(overrides: Partial<DeviceType<any>> = {}): DeviceType<any> {
  return {
    id: 'test.lamp',
    kind: 'hardware',
    meta: { name: 'Lamp', category: 'smart-plug', support: 'experimental', icon: 'sun', models: ['L1'] },
    describe: () => ({
      attributes: [{ key: 'lux', label: 'Light', value: { type: 'number', unit: 'lx' }, quantity: 'illuminance' }],
      events: [{ id: 'bulb.failed', label: 'Bulb failed', level: 'warn', data: { hours: { type: 'number' } } }],
    }),
    config: { fields: { room: { type: 'string', title: 'Room', required: true } } },
    connections: [{ id: 'bus', label: 'Bus', protocol: 'lampish', transport: 'bus' }],
    identify: async () => ({ identity: null, model: null, summary: '' }),
    createSession: async () => session(),
    createSimulator: async () => session(),
    ...overrides,
  } as DeviceType<any>;
}

const baseInput = (type: DeviceType<any>, channel = fakeByteChannel(() => null)) => ({
  type,
  device: { id: savedDeviceId('d-1'), name: 'Hall lamp', config: { room: 'Hall' } },
  connection: { method: 'bus', transport: 'bus', address: 'lamp-1', config: {} },
  secret: () => null,
  protocols: { get: (id: string) => (id === 'lampish' ? protocol : null) },
  transports: { start: async () => ({ open: async () => channel }) as unknown as Transport, available: () => ({ ok: true as const }) },
  store: { get: () => null, set: () => {}, delete: () => {} },
  platform: 'server' as const,
  readOnly: false,
  allowRawFrames: false,
  log: quiet,
});

describe('what a device raises', () => {
  test('an event it declares reaches the holder with its level; one it does not is dropped', async () => {
    const heard: { id: string; level: string; data: unknown }[] = [];
    let raise: ((id: string, data?: Record<string, number>) => void) | null = null;
    const type = lampType({
      createSession: async (ctx) => {
        raise = (id, data) => ctx.event(id, data);
        return session();
      },
    });
    const opened = await openDevice({ ...baseInput(type), event: (event) => heard.push(event) });
    raise!('bulb.failed', { hours: 1200 });
    raise!('bulb.exploded');
    raise!('bulb.failed', { colour: 3 });
    expect(heard.map(({ id, level, data }) => ({ id, level, data }))).toEqual([{ id: 'bulb.failed', level: 'warn', data: { hours: 1200 } }]);
    expect(opened.description().attributes.map((attribute) => attribute.key)).toEqual(['lux']);
    await opened.close();
  });
});

describe('opening a device', () => {
  test('its session is handed a guarded channel: a refused frame never reaches the wire', async () => {
    const channel = fakeByteChannel(() => null);
    let seen: { channel: { kind: string; write?(bytes: Uint8Array): Promise<void> } } | null = null;
    const type = lampType({
      createSession: async (ctx) => {
        seen = ctx.connection as never;
        return session();
      },
    });
    const opened = await openDevice(baseInput(type, channel));
    const write = (seen!.channel as { write(bytes: Uint8Array): Promise<void> }).write;
    await expect(write(new Uint8Array([0]))).rejects.toThrow('Refused: zero');
    expect(channel.written).toEqual([]);
    await opened.close();
  });

  test('a session that never opens times out, and its channel is closed', async () => {
    const channel = fakeByteChannel(() => null);
    let closed = false;
    const originalClose = channel.close.bind(channel);
    channel.close = async () => {
      closed = true;
      await originalClose();
    };
    const type = lampType({ createSession: () => new Promise<DeviceSession>(() => {}) });
    const refusal = await openDevice({ ...baseInput(type, channel), timeoutMs: 50 }).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(OpenRefused);
    expect((refusal as OpenRefused).message).toBe('Opening Hall lamp took longer than 0 s');
    expect((refusal as OpenRefused).status).toBe('error');
    expect(closed).toBe(true);
  });

  test('config its type does not accept is something to set up, not an error', async () => {
    const refusal = await openDevice({ ...baseInput(lampType()), device: { id: savedDeviceId('d-1'), name: 'Hall lamp', config: {} } }).catch((error: unknown) => error);
    expect((refusal as OpenRefused).status).toBe('unconfigured');
  });

  test('scheduled work is skipped while the last run is still going, and stops at close', async () => {
    let runs = 0;
    let release = () => {};
    const type = lampType({
      createSimulator: async (ctx) => {
        ctx.schedule(5, async () => {
          runs += 1;
          await new Promise<void>((resolve) => (release = resolve));
        });
        return session();
      },
    });
    const opened = await openDevice({ ...baseInput(type), connection: null });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(runs).toBe(1); // the first run has not finished: the rest were skipped
    release();
    await opened.close();
    const after = runs;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(runs).toBe(after);
  });
});

describe('watching a device', () => {
  test('what a device saying who it is means', () => {
    expect(identityVerdict('sydpower:AA', null)).toBe('unknown');
    expect(identityVerdict(null, 'sydpower:AA')).toBe('learnt');
    expect(identityVerdict('sydpower:aa', 'sydpower:AA')).toBe('same');
    expect(identityVerdict('sydpower:AA', 'sydpower:BB')).toBe('mismatch');
  });

  test('a connection down too long fails over, once, and is passed over for a while — only when there is another', () => {
    let now = 0;
    const failover = new Failover({ afterMs: 1000, now: () => now });
    failover.note('c1', false);
    now = 500;
    expect(failover.due('c1', true)).toBe(false);
    now = 1500;
    expect(failover.due('c1', false)).toBe(false); // nothing else to try
    expect(failover.due('c1', true)).toBe(true);
    expect(failover.avoided('c1')).toBe(true);
    expect(failover.due('c1', true)).toBe(false);
    now = 3000;
    expect(failover.avoided('c1')).toBe(false);
    failover.note('c2', false);
    failover.note('c2', true);
    now = 9000;
    expect(failover.due('c2', true)).toBe(false); // it came back
  });
});

const connection = (id: string, priority: number, reachable: boolean | null, heldBy: ConnectionView['heldBy'] = { kind: 'server' }): ConnectionView => ({
  id: connectionId(id),
  method: id,
  methodLabel: id,
  transport: 'bus',
  heldBy,
  address: id,
  priority,
  reachable,
  inUse: false,
  lastConnectedAt: null,
  secrets: [],
  config: {},
});

describe('which connection is in use', () => {
  const phone = { kind: 'client' as const, id: clientId('k-phone'), name: 'Phone' };

  test('the reachable one highest in the list; with none reachable, the one being tried', () => {
    expect(activeConnection([connection('wifi', 0, false), connection('ble', 1, true)], 'wifi')).toBe('ble');
    expect(activeConnection([connection('wifi', 0, true), connection('ble', 1, true)], null)).toBe('wifi');
    expect(activeConnection([connection('wifi', 0, false)], 'wifi')).toBe('wifi');
    expect(withInUse([connection('wifi', 0, null), connection('ble', 1, true)], null).map((c) => c.inUse)).toEqual([false, true]);
  });

  test('an app holds its own connection only while nothing above it reaches the device', () => {
    const device = (serverReachable: boolean | null) => ({ connections: [connection('wifi', 0, serverReachable), connection('ble', 1, null, phone)] });
    expect(toHold(device(true), 'k-phone')).toBeNull();
    expect(toHold(device(false), 'k-phone')?.id).toBe(connectionId('ble'));
    expect(toHold(device(null), 'k-phone')?.id).toBe(connectionId('ble'));
    expect(toHold(device(false), 'k-other')).toBeNull();
  });
});

describe('judging the check', () => {
  const type = lampType();
  const known = (active: boolean, removed = false) => ({
    byIdentity: () => ({
      active: active ? { id: savedDeviceId('d-1'), name: 'Hall lamp' } : null,
      removed: removed ? [{ id: savedDeviceId('d-0'), name: 'Old lamp', removedAt: '2026-09-01T00:00:00Z' }] : [],
    }),
  });

  test('new, yours, yours before, and another model', () => {
    const said = { identity: 'lampish:A', model: 'L1', summary: 'On.' };
    expect(judgeCheck(said, { type, types: [type], known: known(false) })).toEqual({ outcome: 'new', summary: 'On.', identity: 'lampish:A' });
    expect(judgeCheck(said, { type, types: [type], known: known(true) })).toMatchObject({ outcome: 'yours', device: { name: 'Hall lamp' } });
    expect(judgeCheck(said, { type, types: [type], known: known(false, true) })).toMatchObject({ outcome: 'removed', devices: [{ name: 'Old lamp' }] });
    const other = lampType({ id: 'test.big', meta: { name: 'Big lamp', category: 'smart-plug', support: 'experimental', icon: 'sun', models: ['L9'] } });
    expect(judgeCheck({ ...said, model: 'L9' }, { type, types: [type, other], known: known(false) })).toMatchObject({ outcome: 'other-model', type: { id: 'test.big' } });
  });

  test('an identity from the sighting stands in when the device does not say', () => {
    expect(judgeCheck({ identity: null, model: null, summary: 'On.' }, { type, types: [type], known: known(false), identityHint: 'lampish:B' })).toMatchObject({ outcome: 'new', identity: 'lampish:B' });
  });
});
