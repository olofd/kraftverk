import { describe, expect, test } from 'bun:test';

import {
  PortSwitchError,
  ReadOnlyError,
  StaleWriteError,
  StationClient,
  WRITE_DEADLINE_MS,
  type StationLink,
} from './client.ts';
import { parseCommand, type ParsedFrame } from '@kraftverk/protocol-sydpower';
import { HOLDING, INPUT, INPUT_REGISTER_COUNT, STATUS, UnsafeWriteError } from './registers.ts';

/**
 * The read-only guard and the write whitelist, tested where they now live.
 *
 * The same class runs wherever a station's connection is held, on the server
 * and in the app, so this is the only implementation of "which writes are
 * allowed" in the repo, and the only place it needs proving.
 */

/** Records every frame that reaches the wire, and never answers. */
class SpyTransport implements StationLink {
  readonly transport = 'mqtt';
  sent: Uint8Array[] = [];
  address = 'AABBCCDDEEFF';
  connected = true;

  async send(frame: Uint8Array) {
    this.sent.push(frame);
  }
  async request(): Promise<ParsedFrame> {
    throw new Error('no response in this test');
  }
  onFrame() {
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
 * A station whose outputs behave like a P280's: a write to an output register
 * toggles it, whatever value was written. Answers reads with its status bits,
 * unless told to stay quiet. Nothing is pushed unprompted.
 */
class TogglingStation implements StationLink {
  readonly transport = 'mqtt';
  address = 'AABBCCDDEEFF';
  connected = true;
  silent = false;
  /** Whether a write changes anything — false for a station that ignores it. */
  obeys = true;
  bits = 0;
  writes: { register: number; value: number }[] = [];

  async send(frame: Uint8Array) {
    const command = parseCommand(frame);
    if (command?.kind !== 'write') return;
    this.writes.push({ register: command.register, value: command.value });
    if (!this.obeys) return;
    const bit =
      command.register === HOLDING.AC_OUTPUT ? STATUS.AC_OUTPUT_ON
      : command.register === HOLDING.DC_OUTPUT ? STATUS.DC_OUTPUT_ON
      : command.register === HOLDING.USB_OUTPUT ? STATUS.USB_OUTPUT_ON
      : 0;
    this.bits ^= bit;
  }

  async request(_frame: Uint8Array, expect: 'input' | 'holding'): Promise<ParsedFrame> {
    if (this.silent) throw new Error('timed out');
    if (expect === 'holding') throw new Error('not modelled');
    const values = Array<number>(INPUT_REGISTER_COUNT).fill(0);
    values[INPUT.STATUS_BITS] = this.bits;
    return { kind: 'registers', fn: 0x04, start: 0, values };
  }

  onFrame(_listener?: (frame: ParsedFrame) => void): () => void {
    return () => {};
  }
}

describe('what the channel carries besides its answers', () => {
  test('a read of other registers — the scan tool’s — is not taken for the station’s state', async () => {
    const station = new TogglingStation();
    station.bits = STATUS.AC_OUTPUT_ON;
    let push: ((frame: ParsedFrame) => void) | null = null;
    station.onFrame = (listener: (frame: ParsedFrame) => void) => {
      push = listener;
      return () => {};
    };
    const client = new StationClient({ transport: station });
    await client.start();
    // The station's own push of its block from register 0 is its state: AC on.
    const telemetry = Array<number>(INPUT_REGISTER_COUNT).fill(0);
    telemetry[INPUT.STATUS_BITS] = STATUS.AC_OUTPUT_ON;
    push!({ kind: 'registers', fn: 0x04, start: 0, values: telemetry });
    const before = client.status();
    expect(before.ports.find((p) => p.id === 'ac')?.enabled).toBe(true);

    // Input registers from 80 on, every bit set: decoded as telemetry, the outlets would all read on and the charge 6553.5 %.
    push!({ kind: 'registers', fn: 0x04, start: 80, values: Array<number>(INPUT_REGISTER_COUNT).fill(0) });
    expect(client.status()).toEqual(before);
    await client.stop();
  });
});

describe('switching an output', () => {
  test('a station that has not answered is not written to — in either direction', async () => {
    const station = new TogglingStation();
    station.silent = true;
    station.bits = STATUS.AC_OUTPUT_ON; // on, but nobody has read that yet
    const client = new StationClient({ transport: station });

    await expect(client.setPort('ac', true)).rejects.toBeInstanceOf(PortSwitchError);
    await expect(client.setPort('ac', false)).rejects.toBeInstanceOf(PortSwitchError);
    expect(station.writes).toHaveLength(0);
    expect(station.bits).toBe(STATUS.AC_OUTPUT_ON);
  });

  test('"on" for outlets that are already on sends nothing, however stale the cache', async () => {
    const station = new TogglingStation();
    const client = new StationClient({ transport: station });
    await client.poll(); // cached: all off
    station.bits = STATUS.AC_OUTPUT_ON; // switched on at the unit since

    const status = await client.setPort('ac', true);
    expect(station.writes).toHaveLength(0);
    expect(station.bits).toBe(STATUS.AC_OUTPUT_ON);
    expect(status.ports.find((p) => p.id === 'ac')?.enabled).toBe(true);
  });

  test('switches, and reports the state the station confirms', async () => {
    const station = new TogglingStation();
    const client = new StationClient({ transport: station });

    const on = await client.setPort('ac', true);
    expect(station.bits).toBe(STATUS.AC_OUTPUT_ON);
    expect(on.ports.find((p) => p.id === 'ac')?.enabled).toBe(true);

    const off = await client.setPort('ac', false);
    expect(station.bits).toBe(0);
    expect(off.ports.find((p) => p.id === 'ac')?.enabled).toBe(false);
    expect(station.writes).toHaveLength(2);
  });

  test('two taps at once switch once, not twice', async () => {
    const station = new TogglingStation();
    const client = new StationClient({ transport: station });

    await Promise.all([client.setPort('dc', true), client.setPort('dc', true)]);
    expect(station.writes).toHaveLength(1);
    expect(station.bits).toBe(STATUS.DC_OUTPUT_ON);
  });

  test('a switch the station does not confirm is reported, not claimed', async () => {
    const station = new TogglingStation();
    station.obeys = false;
    const client = new StationClient({ transport: station });

    await expect(client.setPort('usb', true)).rejects.toThrow(/does not report it on/);
    // Sent once, and never again on its own: another write would toggle.
    expect(station.writes).toHaveLength(1);
  }, 10_000);

  test('a write that waited past its deadline is dropped, not sent late', async () => {
    const station = new TogglingStation();
    const client = new StationClient({ transport: station });
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    try {
      // Hold the queue with a slow read, and let the clock run past the deadline behind it.
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      const request = station.request.bind(station);
      station.request = async (frame, expect) => {
        await held;
        return request(frame, expect);
      };
      const poll = client.poll();
      const write = client.applySettings({ chargeLimit: 80 });
      now += WRITE_DEADLINE_MS + 1;
      release();
      await poll;
      await expect(write).rejects.toBeInstanceOf(StaleWriteError);
      expect(station.writes).toHaveLength(0);
    } finally {
      Date.now = realNow;
    }
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
    second.address = 'FFEEDDCCBBAA';

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
    second.address = 'FFEEDDCCBBAA';

    const client = new StationClient({ transport: first });
    expect(client.mac).toBe('AABBCCDDEEFF');

    client.retarget(second);
    expect(client.mac).toBe('FFEEDDCCBBAA');
    expect(client.transport).toBe(second);
  });
});
