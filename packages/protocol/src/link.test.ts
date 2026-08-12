import { describe, expect, test } from 'bun:test';

import { chunkForWrite, FrameAssembler } from './ble.ts';
import { StationClient, type DiscoveredDevice, type StationTransport } from './client.ts';
import { crc16, parseFrame, type ParsedFrame } from './modbus.ts';
import { HOLDING, HOLDING_REGISTER_COUNT, INPUT, INPUT_REGISTER_COUNT } from './registers.ts';

/**
 * The path the app takes when it talks to a station itself.
 *
 * `StationClient` is what runs over Bluetooth in the browser and on a phone,
 * and over MQTT or noble on the server. These tests drive it through a scripted
 * transport, so what is proven is the part every link shares: that a response
 * off the wire — including one split across BLE notifications — becomes the
 * same `StationStatus` the server would have produced.
 */

/** A response frame in the shape these devices send: header echoed, CRC big-endian. */
function registerResponse(fn: 0x03 | 0x04, start: number, values: number[]): Uint8Array {
  const body = [0x11, fn, (start >> 8) & 0xff, start & 0xff, (values.length >> 8) & 0xff, values.length & 0xff];
  for (const value of values) body.push((value >> 8) & 0xff, value & 0xff);
  const crc = crc16(Uint8Array.from(body));
  return Uint8Array.from([...body, (crc >> 8) & 0xff, crc & 0xff]);
}

const bank = (size: number, values: Record<number, number>): number[] => {
  const regs = new Array(size).fill(0);
  for (const [index, value] of Object.entries(values)) regs[Number(index)] = value;
  return regs;
};

/** A station that answers reads from a fixed pair of register banks. */
class FakeStation implements StationTransport {
  readonly kind = 'direct-web-ble' as const;
  readonly connected = true;
  boundId: string | null = 'station-1';
  sent: Uint8Array[] = [];

  constructor(
    private input: number[],
    private holding: number[]
  ) {}

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
  async request(frame: Uint8Array, expect: 'input' | 'holding'): Promise<ParsedFrame> {
    this.sent.push(frame);
    const values = expect === 'input' ? this.input : this.holding;
    const fn = expect === 'input' ? 0x04 : 0x03;
    return parseFrame(registerResponse(fn, 0, values))!;
  }
  onFrame() {
    return () => {};
  }
  onDiscovery() {
    return () => {};
  }
}

describe('a direct connection decodes what the server would', () => {
  const input = bank(INPUT_REGISTER_COUNT, {
    [INPUT.STATE_OF_CHARGE]: 734, // 73.4%
    [INPUT.DC_INPUT_POWER]: 166,
    [INPUT.TOTAL_INPUT_POWER]: 166,
    [INPUT.TOTAL_OUTPUT_POWER]: 9,
    [INPUT.AC_OUTPUT_POWER]: 8,
    [INPUT.LED_POWER]: 10,
    [INPUT.STATUS_BITS]: 0x1ca4, // every output on, panel delivering, inverter up
    [INPUT.TIME_TO_EMPTY]: 22560,
  });

  const holding = bank(HOLDING_REGISTER_COUNT, {
    [HOLDING.AC_CHARGING_UPPER_LIMIT]: 730, // 73%
    [HOLDING.DISCHARGE_LOWER_LIMIT]: 100, // 10%
    [HOLDING.AC_CHARGING_RATE]: 3, // 1200 W on a P280
    [HOLDING.MAX_CHARGING_CURRENT]: 20,
    [HOLDING.SLEEP_MINUTES]: 480,
  });

  test('a poll produces the full station model', async () => {
    const transport = new FakeStation(input, holding);
    const client = new StationClient({ transport, readOnly: true });

    await client.poll();

    const status = client.status();
    expect(status.level).toBe(73.4);
    expect(status.solarInputWatts).toBe(166);
    expect(status.totalOutputWatts).toBe(9);
    expect(status.state).toBe('charging');
    expect(status.link.transport).toBe('direct-web-ble');
    expect(status.ports.map((port) => port.enabled)).toEqual([true, true, false, true]);

    const settings = client.settings();
    expect(settings.chargeLimit).toBe(73);
    expect(settings.dischargeFloor).toBe(10);
    expect(settings.acChargingWatts).toBe(1200);
  });

  test('polling reads both banks, telemetry first', async () => {
    const transport = new FakeStation(input, holding);
    const client = new StationClient({ transport, readOnly: true });

    await client.poll();

    expect(transport.sent).toHaveLength(2);
    expect(transport.sent[0]![1]).toBe(0x04);
    expect(transport.sent[1]![1]).toBe(0x03);
  });
});

describe('frames split across BLE notifications', () => {
  test('a 168-byte response reassembles from 20-byte packets', () => {
    const response = registerResponse(0x04, 0, bank(INPUT_REGISTER_COUNT, { 56: 1000 }));
    const assembler = new FrameAssembler();

    const frames = chunkForWrite(response, 20).flatMap((chunk) => assembler.push(chunk));

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ kind: 'registers', fn: 0x04 });
    expect(frames[0]!.kind === 'registers' && frames[0]!.values[56]).toBe(1000);
  });

  test('one corrupt byte does not stall the link forever', () => {
    const response = registerResponse(0x03, 0, bank(HOLDING_REGISTER_COUNT, { 67: 730 }));
    const assembler = new FrameAssembler();

    // Junk ahead of a good frame: the assembler must resync, not give up.
    expect(assembler.push([0x11, 0x04, 0xff])).toHaveLength(0);
    const frames = assembler.push(response);

    expect(frames.some((frame) => frame.kind === 'registers' && frame.values[67] === 730)).toBe(true);
  });
});
