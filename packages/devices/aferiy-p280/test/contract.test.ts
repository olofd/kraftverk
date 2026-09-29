import { describe, expect, test } from 'bun:test';

import { capabilitiesOf, readingOf } from '@kraftverk/device-sdk';
import { checkDeviceTypeContract, fakeByteChannel, fakeConnection, fakeMessageChannel, simulatorContext } from '@kraftverk/device-sdk/testing';
import { crc16 } from '@kraftverk/protocol-sydpower';

import p280 from '../src/type.ts';
import { stationSession, type StationSource } from '../src/station.ts';
import { SimulatedStation } from '../src/simulator.ts';
import { INPUT, INPUT_REGISTER_COUNT } from '../src/model/registers.ts';

/** A telemetry response as a P280 sends it: 73.4 %, 166 W in. */
function telemetry(): Uint8Array {
  const values = new Array(INPUT_REGISTER_COUNT).fill(0);
  values[INPUT.STATE_OF_CHARGE] = 734;
  values[INPUT.TOTAL_INPUT_POWER] = 166;
  values[INPUT.DC_INPUT_POWER] = 166;
  const body = [0x11, 0x04, 0, 0, 0, values.length];
  for (const value of values) body.push((value >> 8) & 0xff, value & 0xff);
  const crc = crc16(Uint8Array.from(body));
  return Uint8Array.from([...body, (crc >> 8) & 0xff, crc & 0xff]);
}

const MAC = 'AABBCC000001';

/** A P280 on the broker, answering polls on its own topics. */
const overWifi = () =>
  fakeConnection({
    method: 'wifi',
    protocol: 'sydpower',
    transport: 'mqtt',
    address: MAC,
    channel: fakeMessageChannel((topic, payload) =>
      topic === `${MAC}/client/request/data` && payload[1] === 0x04 ? [{ topic: `${MAC}/device/response/client/04`, payload: telemetry() }] : []
    ),
  });

/** The same station over a server's radio, answering in two notifications. */
const overBluetooth = () =>
  fakeConnection({
    method: 'bluetooth',
    protocol: 'sydpower',
    transport: 'ble',
    address: MAC,
    channel: fakeByteChannel((bytes) => (bytes[1] === 0x04 ? [telemetry().slice(0, 40), telemetry().slice(40)] : null)),
  });

describe('the P280 device type', () => {
  test('keeps the device-type contract, and says who it is over both methods', async () => {
    expect(await checkDeviceTypeContract(p280, { settleMs: 1_500, connections: [overWifi, overBluetooth] })).toEqual([]);
  });

  test('is recognised as the same station however it is reached', async () => {
    const quiet = { info: () => {}, warn: () => {}, error: () => {} };
    const context = { config: {}, log: quiet, signal: AbortSignal.timeout(10_000) };
    const wifi = await p280.identify(overWifi(), context);
    const ble = await p280.identify(overBluetooth(), context);
    expect(wifi.identity).toBe(`sydpower:${MAC}`);
    expect(ble.identity).toBe(wifi.identity);
    expect(wifi.summary).toBe('Battery 73 %, charging 166 W.');
  });

  test('a browser, which hides the MAC, gives no identity rather than a wrong one', async () => {
    const quiet = { info: () => {}, warn: () => {}, error: () => {} };
    const { channel } = overBluetooth();
    const inBrowser = fakeConnection({ method: 'bluetooth', protocol: 'sydpower', transport: 'ble', address: 'k3Jx9-browser-handle', channel });
    const found = await p280.identify(inBrowser, { config: {}, log: quiet, signal: AbortSignal.timeout(10_000) });
    expect(found.identity).toBeNull();
  });

  test('its simulator remembers settings in the device’s own store', async () => {
    const { context, stop } = simulatorContext(p280);
    const first = await p280.createSimulator(context);
    await first.write!({ chargeLimit: 80 });
    await first.close();

    const second = await p280.createSimulator(context);
    expect(readingOf(second.readings(), 'chargeLimit')?.value).toBe(80);
    await second.close();
    stop();
  });

  test('its outlets are parts that switch, its mains an input, and each expansion battery a part of its own', async () => {
    const declared = p280.describe({});
    expect(capabilitiesOf(declared, 'outlet.ac')).toEqual(['switch', 'powerMeter']);
    expect(capabilitiesOf(declared, 'input.ac')).toEqual(['acInput']);
    expect(capabilitiesOf(declared, 'main')).toEqual(['battery']);

    const { context, stop } = simulatorContext(p280);
    const session = await p280.createSimulator(context);
    const packs = session.readings().filter((reading) => reading.key.startsWith('pack.'));
    const described = session.description?.();
    expect(packs.length).toBeGreaterThan(0);
    expect(described?.parts?.filter((part) => part.kind === 'battery').length).toBe(packs.length);
    expect(capabilitiesOf(described!, 'pack.1')).toEqual(['battery']);
    await session.close();
    stop();
  });
});

describe('writing a P280’s settings through its session', () => {
  /** A source that records what reaches it, so a refusal can be shown to happen first. */
  const recording = () => {
    const station = new SimulatedStation();
    const applied: unknown[] = [];
    const source: StationSource = {
      status: () => station.status(),
      settings: () => station.settings(),
      setPort: (id, on) => station.setPort(id, on),
      applySettings: async (patch) => {
        applied.push(patch);
        return station.applySettings(patch);
      },
    };
    return { session: stationSession(source, { identity: null, transport: 'sim', connected: () => true }), applied };
  };

  test('a whole-machine sleep time of zero never reaches the station — it destroys it', async () => {
    const { session, applied } = recording();
    await expect(session.write!({ sleepMinutes: '0' })).rejects.toThrow();
    expect(applied).toEqual([]);
  });

  test('only what was asked for is sent', async () => {
    const { session, applied } = recording();
    await session.write!({ chargeLimit: 85 });
    expect(applied).toEqual([{ chargeLimit: 85 }]);
  });
});
