import { describe, expect, test } from 'bun:test';

import {
  ReadOnlyError,
  StationClient,
  type DiscoveredDevice,
  type StationTransport,
} from './client.ts';
import type { ParsedFrame } from './modbus.ts';
import { HOLDING, UnsafeWriteError } from './registers.ts';

/**
 * The read-only guard and the write whitelist, tested where they now live.
 *
 * These used to cover the server's device driver. They did not move because the
 * file did: the same class is what the app runs when it connects to a station
 * directly over Bluetooth, so this is now the only implementation of "which
 * writes are allowed" in the repo, and the only place it needs proving.
 */

/** Records every frame that reaches the wire, and never answers. */
class SpyTransport implements StationTransport {
  readonly kind = 'mqtt' as const;
  sent: Uint8Array[] = [];
  boundId: string | null = 'AABBCCDDEEFF';
  connected = true;

  async start() {}
  async stop() {}
  discovered(): DiscoveredDevice[] {
    return [];
  }
  async bind() {}
  async unbind() {}
  async send(frame: Uint8Array) {
    this.sent.push(frame);
  }
  async request(): Promise<ParsedFrame> {
    throw new Error('no response in this test');
  }
  onFrame() {
    return () => {};
  }
  onDiscovery() {
    return () => {};
  }
}

describe('read-only mode', () => {
  test('refuses a setting write and sends nothing to the station', async () => {
    const transport = new SpyTransport();
    const client = new StationClient({ transport, readOnly: true });

    await expect(client.applySettings({ chargeLimit: 80 })).rejects.toBeInstanceOf(ReadOnlyError);
    expect(transport.sent).toHaveLength(0);
  });

  test('records what was blocked, so it is visible in diagnostics', async () => {
    const transport = new SpyTransport();
    const client = new StationClient({ transport, readOnly: true });

    await client.applySettings({ chargeLimit: 80 }).catch(() => {});

    expect(client.blockedWrites).toHaveLength(1);
    expect(client.blockedWrites[0]).toMatchObject({
      register: HOLDING.AC_CHARGING_UPPER_LIMIT,
      value: 800,
    });
  });

  test('an unsafe value is still reported as unsafe, not merely blocked', async () => {
    const transport = new SpyTransport();
    const client = new StationClient({ transport, readOnly: true });

    // sleepMinutes 0 bricks the device. It must fail the whitelist, not the
    // read-only check, so the reason survives if read-only is ever turned off.
    await expect(client.applySettings({ sleepMinutes: 0 as never })).rejects.toBeInstanceOf(
      UnsafeWriteError
    );
    expect(transport.sent).toHaveLength(0);
  });

  test('a port toggle is blocked too', async () => {
    const transport = new SpyTransport();
    const client = new StationClient({ transport, readOnly: true });

    await expect(client.setPort('usb', true)).rejects.toBeInstanceOf(ReadOnlyError);
    expect(transport.sent).toHaveLength(0);
  });

  test('writes are allowed when read-only is off', async () => {
    const transport = new SpyTransport();
    const client = new StationClient({ transport, readOnly: false });

    await client.applySettings({ chargeLimit: 80 }).catch(() => {});
    expect(transport.sent.length).toBeGreaterThan(0);
  });
});

/**
 * Which station a write actually reaches.
 *
 * Writes are queued so only one MODBUS exchange is in flight at a time, and the
 * queue defers them by a microtask. A server holding several stations can
 * retarget a client in that gap — and a task that reads the link when it *runs*
 * would send the write to whichever station the client points at by then. One
 * of these registers permanently bricks the hardware, so "the wrong station" is
 * not an acceptable outcome for a write.
 */
describe('retargeting a client mid-flight', () => {
  test('a write queued before a rebind is refused, not sent to the new station', async () => {
    const first = new SpyTransport();
    const second = new SpyTransport();
    second.boundId = 'FFEEDDCCBBAA';

    const client = new StationClient({ transport: first, readOnly: false });

    // Not awaited: the write is now sitting on the queue, pinned to `first`.
    const pending = client.applySettings({ chargeLimit: 80 });
    // The station is swapped out from under it before the queue drains.
    client.retarget(second);

    await expect(pending).rejects.toThrow(/station changed/i);
    expect(second.sent).toHaveLength(0);
  });

  test('the link a client reports is the one it was retargeted to', () => {
    const first = new SpyTransport();
    const second = new SpyTransport();
    second.boundId = 'FFEEDDCCBBAA';

    const client = new StationClient({ transport: first });
    expect(client.mac).toBe('AABBCCDDEEFF');

    client.retarget(second);
    expect(client.mac).toBe('FFEEDDCCBBAA');
    expect(client.transport).toBe(second);
  });
});
