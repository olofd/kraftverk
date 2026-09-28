import { describe, expect, test } from 'bun:test';

import { savedDeviceId, type ConfigValues, type DeviceSession, type SettingsSpec } from '@kraftverk/device-sdk';

import { ActionGateway, CONFIRMATION, type AuditEntry } from './gateway.ts';

/*
  Settings go through the gateway like commands (docs/ARCHITECTURE.md step 18):
  held to the type's schema, refused while read-only, confirmed where a wrong
  value damages the hardware, never changed there by an automation, and
  verified by what the device reports afterwards.
*/

const SPEC: SettingsSpec = {
  schema: {
    fields: {
      led: { type: 'enum', title: 'Light', options: [{ value: 'off', label: 'Off' }, { value: 'on', label: 'On' }] },
      sleepMinutes: { type: 'number', title: 'Sleep after', min: 0, max: 480 },
    },
  },
  dangerous: ['sleepMinutes'],
};

/** A device that remembers what it is told — or, `stubborn`, accepts and keeps what it had. */
function station(stubborn = false) {
  const values: ConfigValues = { led: 'off', sleepMinutes: 30 };
  const writes: ConfigValues[] = [];
  const session: DeviceSession = {
    health: () => ({ status: 'connected', detail: 'Fine', owner: 'server', transport: 'test', lastReadingAt: null }),
    readings: () => [],
    capability: (() => null) as DeviceSession['capability'],
    readSettings: () => ({ ...values }),
    writeSettings: async (patch) => {
      writes.push(patch);
      if (!stubborn) Object.assign(values, patch);
      return { ...values };
    },
    close: async () => {},
  };
  return { session, writes };
}

function gateway(options: { stubborn?: boolean; readOnly?: boolean } = {}) {
  const device = station(options.stubborn);
  const recorded: AuditEntry[] = [];
  const g = new ActionGateway({
    device: () => ({ name: 'Garage station', session: device.session, offline: 'n/a', settings: SPEC }),
    feeds: () => null,
    isReadOnly: () => options.readOnly ?? false,
    record: (entry) => recorded.push(entry),
    policy: { verifyTimeoutMs: 100 },
  });
  return { g, device, recorded };
}

const intent = (patch: ConfigValues, extra: Partial<Parameters<ActionGateway['writeSettings']>[0]> = {}) => ({
  deviceId: savedDeviceId('d-1'),
  patch,
  actor: 'user' as const,
  by: 'olof',
  ...extra,
});

describe('settings through the gateway', () => {
  test('a setting is written, read back, and both ends are in the timeline', async () => {
    const { g, device, recorded } = gateway();
    const result = await g.writeSettings(intent({ led: 'on' }));
    expect(result).toMatchObject({ outcome: 'verified', values: { led: 'on' } });
    expect(device.writes).toEqual([{ led: 'on' }]);
    expect(recorded.map((entry) => entry.kind)).toEqual(['settings.intent', 'settings.verified']);
  });

  test('only settings the type declares, held to its schema', async () => {
    const { g, device } = gateway();
    expect(await g.writeSettings(intent({ turbo: true }))).toMatchObject({ outcome: 'refused', detail: 'No such setting: turbo' });
    expect((await g.writeSettings(intent({ led: 'disco' }))).outcome).toBe('refused');
    expect(device.writes).toEqual([]);
  });

  test('read-only refuses before anything is sent', async () => {
    const { g, device } = gateway({ readOnly: true });
    expect((await g.writeSettings(intent({ led: 'on' }))).detail).toContain('read-only');
    expect(device.writes).toEqual([]);
  });

  test('a setting that can damage the hardware is confirmed by a person, and never changed by an automation', async () => {
    const { g, device } = gateway();
    const asked = await g.writeSettings(intent({ sleepMinutes: 60 }));
    expect(asked).toMatchObject({ outcome: 'refused', needsConfirmation: true });
    expect(asked.detail).toContain('Sleep after');
    expect((await g.writeSettings(intent({ sleepMinutes: 60 }, { actor: 'automation', by: 'automation:x', confirmation: CONFIRMATION }))).outcome).toBe('refused');
    expect(device.writes).toEqual([]);
    expect((await g.writeSettings(intent({ sleepMinutes: 60 }, { confirmation: CONFIRMATION }))).outcome).toBe('verified');
  });

  test('a device that accepts but does not change is unverified, not success', async () => {
    const { g } = gateway({ stubborn: true });
    expect(await g.writeSettings(intent({ led: 'on' }))).toMatchObject({ outcome: 'unverified', values: { led: 'off' } });
  });
});
