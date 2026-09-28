import { beforeEach, describe, expect, mock, test } from 'bun:test';

import type { Reading } from '@kraftverk/device-sdk';

/*
  What an app owes the server for the connections it holds: readings, audit
  entries and store writes, kept while the server is away and sent when it is
  back. The API is stood in for; this checks the queue, not the network.
*/

const sent = { readings: [] as { deviceId: string; readings: readonly Reading[]; identity?: string | null }[], audit: [] as unknown[][] };
let serverAway = false;

mock.module('@kraftverk/api-client', () => ({
  uploadReadings: async (deviceId: string, input: { readings: readonly Reading[]; identity?: string | null }) => {
    if (serverAway) throw new Error('away');
    sent.readings.push({ deviceId, readings: input.readings, identity: input.identity });
    return { live: 0, history: input.readings.length, refused: 0 };
  },
  uploadAudit: async (_clientId: string, entries: unknown[]) => {
    if (serverAway) throw new Error('away');
    sent.audit.push(entries);
    return { recorded: entries.length };
  },
  putDeviceStore: async () => {
    if (serverAway) throw new Error('away');
  },
}));

const { Uplink } = await import('./uplink');
const { clearPreference, readPreference } = await import('../lib/preferences');

beforeEach(() => {
  sent.readings = [];
  sent.audit = [];
  serverAway = false;
  clearPreference('test.uplink');
});

const reading = (key: string, minute: number, value: number): Reading => ({ key, value, at: new Date(Date.UTC(2026, 8, 28, 10, minute)).toISOString() });

describe('the uplink', () => {
  test('keeps one reading per measurement per minute, and sends them with who the device said it is', async () => {
    let collected: Reading[] = [reading('soc', 0, 80), reading('soc', 0, 81), reading('soc', 1, 82)];
    const uplink = new Uplink({
      clientId: () => 'k-1',
      key: 'test.uplink',
      collect: () => [{ deviceId: 'd-1', connectionId: 'c-1', identity: 'sydpower:AA', readings: collected }],
    });
    await uplink.flush();
    expect(sent.readings).toHaveLength(1);
    expect(sent.readings[0]!.readings.map((r) => r.value)).toEqual([81, 82]);
    expect(sent.readings[0]!.identity).toBe('sydpower:AA');

    // What went up is not sent again.
    collected = [];
    await uplink.flush();
    expect(sent.readings).toHaveLength(1);
  });

  test('keeps everything while the server is away, and sends it when it is back', async () => {
    const uplink = new Uplink({ clientId: () => 'k-1', key: 'test.uplink', collect: () => [] });
    serverAway = true;
    uplink.audit({ at: '2026-09-28T10:00:00Z', kind: 'command.verified', summary: 'Switched on' });
    await uplink.flush();
    expect(sent.audit).toEqual([]);
    expect(uplink.backlog).toBe(1);

    serverAway = false;
    await uplink.flush();
    expect(sent.audit).toHaveLength(1);
    expect(uplink.backlog).toBe(0);
  });

  test('the audit queue survives a reload', () => {
    serverAway = true;
    new Uplink({ clientId: () => null, key: 'test.uplink', collect: () => [] }).audit({ at: '2026-09-28T10:00:00Z', kind: 'x', summary: 'Kept' });
    expect(JSON.parse(readPreference('test.uplink')!)).toHaveLength(1);
    expect(new Uplink({ clientId: () => null, key: 'test.uplink', collect: () => [] }).backlog).toBe(1);
  });

  test('nothing is sent before this app is registered', async () => {
    const uplink = new Uplink({ clientId: () => null, key: 'test.uplink', collect: () => [{ deviceId: 'd-1', connectionId: 'c-1', identity: null, readings: [reading('soc', 0, 80)] }] });
    await uplink.flush();
    expect(sent.readings).toEqual([]);
    expect(uplink.backlog).toBe(1);
  });
});
