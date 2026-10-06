import { describe, expect, test } from 'bun:test';

import { fakeByteChannel, fakeMessageChannel } from '@kraftverk/device-sdk/testing';

import { SLEEP_REGISTER } from './guard.ts';
import { linkOver } from './link.ts';
import { crc16, readHoldingRegisters, readInputRegisters, writeRegister } from './modbus.ts';
import { brokerPolicy } from './mqtt.ts';

/**
 * One link, two channels: what a station says must come out the same whether
 * it travelled over a broker's topics or a Bluetooth characteristic pair — and
 * the frame that bricks a station must reach neither.
 */

/** A response in the shape these stations send: header echoed, CRC big-endian. */
function registerResponse(fn: 0x03 | 0x04, start: number, values: number[]): Uint8Array {
  const body = [0x11, fn, (start >> 8) & 0xff, start & 0xff, (values.length >> 8) & 0xff, values.length & 0xff];
  for (const value of values) body.push((value >> 8) & 0xff, value & 0xff);
  const crc = crc16(Uint8Array.from(body));
  return Uint8Array.from([...body, (crc >> 8) & 0xff, crc & 0xff]);
}

const MAC = 'AABBCC001122';
const telemetry = registerResponse(0x04, 0, Array.from({ length: 80 }, (_, i) => i));
const settings = registerResponse(0x03, 0, Array.from({ length: 80 }, () => 7));

describe('over a broker', () => {
  /** A station on the broker: polls answer on 04 and data, and a write echo on data too. */
  const station = () =>
    fakeMessageChannel((topic, payload) => {
      expect(topic).toBe(`${MAC}/client/request/data`);
      const fn = payload[1];
      if (fn === 0x04) return [{ topic: `${MAC}/device/response/client/04`, payload: telemetry }];
      if (fn === 0x03) {
        // The echo of an earlier write arrives first on the same channel.
        return [
          { topic: `${MAC}/device/response/client/data`, payload: writeRegister(26, 1) },
          { topic: `${MAC}/device/response/client/data`, payload: settings },
        ];
      }
      return [];
    });

  test('an answer is matched by its channel and function, not by what arrived first', async () => {
    const link = linkOver({ channel: station(), address: MAC.toLowerCase(), transport: 'mqtt' });
    const input = await link.request(readInputRegisters(0, 80), 'input', 1000);
    expect(input).toMatchObject({ kind: 'registers', fn: 0x04 });
    const holding = await link.request(readHoldingRegisters(0, 80), 'holding', 1000);
    expect(holding).toMatchObject({ kind: 'registers', fn: 0x03, values: Array(80).fill(7) });
  });

  test('the brick write never reaches the broker', async () => {
    const channel = station();
    const link = linkOver({ channel, address: MAC, transport: 'mqtt' });
    await expect(link.send(writeRegister(SLEEP_REGISTER, 0))).rejects.toThrow('bricks');
    expect(channel.published).toEqual([]);
  });

  test('a disconnected broker is said at once, not after a timeout', async () => {
    const channel = station();
    channel.setConnected(false);
    const link = linkOver({ channel, address: MAC, transport: 'mqtt' });
    await expect(link.request(readInputRegisters(0, 80), 'input', 5000)).rejects.toThrow('not connected');
  });
});

describe('over Bluetooth', () => {
  test('a response split across notifications is one frame', async () => {
    const channel = fakeByteChannel((bytes) => (bytes[1] === 0x04 ? [telemetry.slice(0, 20), telemetry.slice(20, 100), telemetry.slice(100)] : null));
    const link = linkOver({ channel, address: MAC, transport: 'ble' });
    const answer = await link.request(readInputRegisters(0, 80), 'input', 1000);
    expect(answer).toMatchObject({ kind: 'registers', fn: 0x04 });
    if (answer.kind === 'registers') expect(answer.values).toHaveLength(80);
  });

  test('the brick write never reaches the characteristic', async () => {
    const channel = fakeByteChannel(() => null);
    const link = linkOver({ channel, address: MAC, transport: 'ble' });
    await expect(link.send(writeRegister(SLEEP_REGISTER, 0))).rejects.toThrow('bricks');
    expect(channel.written).toEqual([]);
  });

  test('writes are spaced, because the station drops frames sent too close together', async () => {
    const channel = fakeByteChannel(() => null);
    const link = linkOver({ channel, address: MAC, transport: 'ble' });
    const started = Date.now();
    await link.send(readInputRegisters(0, 1));
    await link.send(readInputRegisters(0, 1));
    expect(Date.now() - started).toBeGreaterThanOrEqual(450);
  });
});

describe('what the broker is told', () => {
  test('a station is known by its topics, and so are commands to it', () => {
    expect(brokerPolicy.fromDevice(`${MAC}/device/response/client/04`)).toEqual({ address: MAC, channel: '04' });
    expect(brokerPolicy.fromDevice('some/other/topic')).toBeNull();
    expect(brokerPolicy.subscribedBy(`${MAC.toLowerCase()}/client/request/data`)).toBe(MAC);
    expect(brokerPolicy.commandFor(`${MAC}/client/request/data`)).toBe(MAC);
    expect(brokerPolicy.commandFor(`/${MAC}/client/request`)).not.toBeNull();
    expect(brokerPolicy.commandFor(`${MAC}/device/response/04`)).toBeNull();
  });

  test('the broker refuses the brick write too, and pairs replies with what asked for them', () => {
    expect(brokerPolicy.refuse(writeRegister(SLEEP_REGISTER, 0))).toContain('bricks');
    expect(brokerPolicy.describeCommand(readInputRegisters(0, 80))).toMatchObject({ level: 'debug', awaits: 'input' });
    expect(brokerPolicy.describeCommand(writeRegister(26, 1))).toMatchObject({ level: 'info', awaits: 'write:26' });
    expect(brokerPolicy.describeMessage('04', telemetry)).toMatchObject({ answers: 'input' });
    expect(brokerPolicy.describeMessage('data', writeRegister(26, 1))).toMatchObject({ answers: 'write:26' });
  });
});
