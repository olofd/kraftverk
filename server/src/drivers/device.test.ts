import { describe, expect, test } from 'bun:test';

import { DeviceDriver, ReadOnlyError } from './device.ts';
import { HOLDING, UnsafeWriteError } from '../protocol/registers.ts';
import type { ParsedFrame } from '../protocol/modbus.ts';
import type { DiscoveredDevice, Transport } from '../transport/types.ts';

/** Records every frame that reaches the wire, and never answers. */
class SpyTransport implements Transport {
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
    const driver = new DeviceDriver({ transport, readOnly: true });

    await expect(driver.applySettings({ chargeLimit: 80 })).rejects.toBeInstanceOf(ReadOnlyError);
    expect(transport.sent).toHaveLength(0);
  });

  test('records what was blocked, so it is visible in diagnostics', async () => {
    const transport = new SpyTransport();
    const driver = new DeviceDriver({ transport, readOnly: true });

    await driver.applySettings({ chargeLimit: 80 }).catch(() => {});

    expect(driver.blockedWrites).toHaveLength(1);
    expect(driver.blockedWrites[0]).toMatchObject({
      register: HOLDING.AC_CHARGING_UPPER_LIMIT,
      value: 800,
    });
  });

  test('an unsafe value is still reported as unsafe, not merely blocked', async () => {
    const transport = new SpyTransport();
    const driver = new DeviceDriver({ transport, readOnly: true });

    // sleepMinutes 0 bricks the device. It must fail the whitelist, not the
    // read-only check, so the reason survives if read-only is ever turned off.
    await expect(
      driver.applySettings({ sleepMinutes: 0 as never })
    ).rejects.toBeInstanceOf(UnsafeWriteError);
    expect(transport.sent).toHaveLength(0);
  });

  test('a port toggle is blocked too', async () => {
    const transport = new SpyTransport();
    const driver = new DeviceDriver({ transport, readOnly: true });

    await expect(driver.setPort('usb', true)).rejects.toBeInstanceOf(ReadOnlyError);
    expect(transport.sent).toHaveLength(0);
  });

  test('writes are allowed when read-only is off', async () => {
    const transport = new SpyTransport();
    const driver = new DeviceDriver({ transport, readOnly: false });

    await driver.applySettings({ chargeLimit: 80 }).catch(() => {});
    expect(transport.sent.length).toBeGreaterThan(0);
  });
});
