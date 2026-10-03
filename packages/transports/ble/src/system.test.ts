import { describe, expect, test } from 'bun:test';

import { BleChannel } from './system.ts';

/*
  A connection over the server's radio, over a peripheral of the tests' own:
  whatever stops a connection on its way — the channel closed meanwhile, a
  step that throws — lets go of the link it made. A station that takes one
  connection is otherwise held by nobody, locked from the phone and its app.
*/

const LAYOUT = { service: '0000fff0-0000-1000-8000-00805f9b34fb', write: '0000fff2-0000-1000-8000-00805f9b34fb', notify: '0000fff1-0000-1000-8000-00805f9b34fb' };

/** A peripheral whose connect waits until the test says, and whose discovery may throw. */
function aPeripheral(options: { discoveryFails?: boolean } = {}) {
  let answer!: () => void;
  const answered = new Promise<void>((resolve) => (answer = resolve));
  const said = { disconnects: 0 };
  const characteristic = (uuid: string) => ({ uuid, properties: [], removeAllListeners() {}, on() {}, subscribeAsync: async () => {}, writeAsync: async () => {} });
  const peripheral = {
    connectAsync: () => answered,
    disconnectAsync: async () => void (said.disconnects += 1),
    discoverAllServicesAndCharacteristicsAsync: async () => {
      if (options.discoveryFails) throw new Error('The GATT database could not be read');
      return { services: [{ uuid: 'fff0' }], characteristics: [characteristic('fff2'), characteristic('fff1')] };
    },
    removeAllListeners() {},
    once() {},
  };
  return { peripheral, answer, said };
}

const aChannel = (peripheral: unknown) =>
  new BleChannel('AA:BB:CC:00:00:01', { peripheral: () => peripheral } as never, { gatt: [LAYOUT] } as never, () => {}, { log: () => {} } as never);

describe('a Bluetooth connection on the server', () => {
  test('connects, and says so', async () => {
    const { peripheral, answer, said } = aPeripheral();
    const channel = aChannel(peripheral);
    answer();
    await channel.connect();
    expect(channel.connected).toBe(true);
    expect(said.disconnects).toBe(0);
    await channel.close();
  });

  test('closed while it connects: the link it made is let go of, and it never says it is connected', async () => {
    const { peripheral, answer, said } = aPeripheral();
    const channel = aChannel(peripheral);
    const connecting = channel.connect();
    await channel.close();
    const disconnectsOnClose = said.disconnects;
    answer();
    await expect(connecting).rejects.toThrow('Closed while connecting');
    expect(channel.connected).toBe(false);
    expect(said.disconnects).toBe(disconnectsOnClose + 1);
  });

  test('a step after the link is made that throws lets go of the link', async () => {
    const { peripheral, answer, said } = aPeripheral({ discoveryFails: true });
    const channel = aChannel(peripheral);
    answer();
    await expect(channel.connect()).rejects.toThrow('could not be read');
    expect(said.disconnects).toBe(1);
    await channel.close();
  });
});
