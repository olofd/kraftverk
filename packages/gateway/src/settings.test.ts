import { describe, expect, test } from 'bun:test';

import { savedDeviceId, type AuditRecord, type DeviceDescription, type DeviceSession, type Value } from '@kraftverk/device-sdk';

import { ActionGateway, type WriteIntent } from './gateway.ts';

/*
  Settings go through the gateway like commands: attributes the description
  says can be written, held to their types, refused while read-only, confirmed
  where a wrong value damages the hardware, never changed there by an
  automation, and verified by what the device reports afterwards.
*/

const DESCRIPTION: DeviceDescription = {
  attributes: [
    { key: 'soc', label: 'Charge', value: { type: 'number', unit: '%' }, quantity: 'percent', means: 'battery.soc' },
    {
      key: 'led',
      label: 'Light',
      value: { type: 'enum', options: [{ value: 'off', label: 'Off' }, { value: 'on', label: 'On' }] },
      access: 'write',
      category: 'config',
    },
    { key: 'sleepMinutes', label: 'Sleep after', value: { type: 'number', min: 1, max: 480 }, access: 'write', category: 'config', dangerous: true },
  ],
};

/** A device that remembers what it is told — or, `stubborn`, accepts and keeps what it had. */
function station(stubborn = false) {
  const values: Record<string, Value> = { led: 'off', sleepMinutes: 30 };
  const writes: Record<string, Value>[] = [];
  const at = new Date().toISOString();
  const session: DeviceSession = {
    health: () => ({ status: 'connected', detail: 'Fine', owner: 'server', transport: 'test', lastReadingAt: null }),
    readings: () => [{ key: 'soc', value: 80, at }, ...Object.entries(values).map(([key, value]) => ({ key, value, at }))],
    command: async () => ({ accepted: false, error: 'No commands' }),
    write: async (patch) => {
      writes.push({ ...patch });
      if (!stubborn) Object.assign(values, patch);
      return { ...values };
    },
    close: async () => {},
  };
  return { session, writes };
}

function gateway(options: { stubborn?: boolean; readOnly?: boolean } = {}) {
  const device = station(options.stubborn);
  const recorded: AuditRecord[] = [];
  const g = new ActionGateway({
    device: () => ({ name: 'Garage station', session: device.session, description: DESCRIPTION, offline: 'n/a' }),
    linksFrom: () => [],
    isReadOnly: () => options.readOnly ?? false,
    record: (entry) => recorded.push(entry),
    policy: { verifyTimeoutMs: 100 },
  });
  return { g, device, recorded };
}

const intent = (patch: Record<string, Value>, extra: Partial<WriteIntent> = {}): WriteIntent => ({
  deviceId: savedDeviceId('d-1'),
  patch,
  actor: 'user',
  by: 'olof',
  ...extra,
});

describe('settings through the gateway', () => {
  test('a setting is written, read back, and both ends are in the timeline', async () => {
    const { g, device, recorded } = gateway();
    const result = await g.write(intent({ led: 'on' }));
    expect(result).toMatchObject({ outcome: 'verified', values: { led: 'on' } });
    expect(device.writes).toEqual([{ led: 'on' }]);
    expect(recorded.map((entry) => entry.kind)).toEqual(['settings.intent', 'settings.verified']);
  });

  test('only attributes that can be written, held to their types', async () => {
    const { g, device } = gateway();
    expect(await g.write(intent({ turbo: true }))).toMatchObject({ outcome: 'refused', detail: 'No such setting: turbo' });
    expect(await g.write(intent({ soc: 100 }))).toMatchObject({ outcome: 'refused', detail: 'No such setting: soc' });
    expect(await g.write(intent({ led: 'disco' }))).toMatchObject({ outcome: 'refused', detail: 'Light must be one of: off, on' });
    expect(device.writes).toEqual([]);
  });

  test('one write per setting per dwell: a second before the first settled is refused, another setting is not', async () => {
    const { g, device } = gateway();
    expect((await g.write(intent({ led: 'on' }))).outcome).toBe('verified');
    const again = await g.write(intent({ led: 'off' }));
    expect(again.outcome).toBe('refused');
    expect(again.detail).toMatch(/^Too soon: Light was changed 0 s ago; 2 s of the dwell time remains$/);
    expect(device.writes).toEqual([{ led: 'on' }]);
  });

  test('read-only refuses before anything is sent', async () => {
    const { g, device } = gateway({ readOnly: true });
    expect((await g.write(intent({ led: 'on' }))).detail).toContain('read-only');
    expect(device.writes).toEqual([]);
  });

  test('a setting that can damage the hardware is confirmed by a person, and never changed by an automation', async () => {
    const { g, device } = gateway();
    const asked = await g.write(intent({ sleepMinutes: 60 }));
    // Read before matching: bun's toMatchObject writes its matchers into what it was given.
    const token = asked.needsConfirmation;
    expect(asked).toMatchObject({ outcome: 'refused', needsConfirmation: expect.any(String) });
    expect(asked.detail).toContain('Sleep after');
    expect((await g.write(intent({ sleepMinutes: 60 }, { actor: 'automation', by: 'automation:x', confirmation: token }))).outcome).toBe('refused');
    expect(device.writes).toEqual([]);
    // The token is for this patch: another value is asked about afresh.
    const other = await g.write(intent({ sleepMinutes: 120 }, { confirmation: token }));
    expect(other.needsConfirmation).toEqual(expect.any(String));
    expect((await g.write(intent({ sleepMinutes: 120 }, { confirmation: other.needsConfirmation }))).outcome).toBe('verified');
  });

  test('a device that accepts but does not change is unverified, not success', async () => {
    const { g } = gateway({ stubborn: true });
    expect(await g.write(intent({ led: 'on' }))).toMatchObject({ outcome: 'unverified', values: { led: 'off' } });
  });
});
