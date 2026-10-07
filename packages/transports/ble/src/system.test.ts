import { describe, expect, test } from 'bun:test';

import type { Link, Radio } from './radio.ts';
import { BleChannel } from './system.ts';

/*
  A connection over the server's radio, over a radio of the tests' own:
  whatever stops a connection on its way — the channel closed meanwhile, a
  step that throws — lets go of the link it made. A station that takes one
  connection is otherwise held by nobody, locked from the phone and its app.
*/

const LAYOUT = { service: '0000fff0-0000-1000-8000-00805f9b34fb', write: '0000fff2-0000-1000-8000-00805f9b34fb', notify: '0000fff1-0000-1000-8000-00805f9b34fb' };

/** A radio whose connect waits until the test says, and whose GATT discovery may fail. */
function aRadio(options: { discoveryFails?: boolean } = {}) {
  let answer!: () => void;
  const answered = new Promise<void>((resolve) => (answer = resolve));
  const said = { drops: 0, written: [] as Uint8Array[] };
  const link: Link = {
    gatt: { services: ['fff0'], characteristics: [{ uuid: 'fff2', properties: ['write'] }, { uuid: 'fff1', properties: ['notify'] }] },
    subscribe: async () => {},
    write: async (_uuid, bytes) => void said.written.push(bytes),
    onDisconnect: () => {},
    disconnect: async () => void (said.drops += 1),
  };
  const radio: Radio = {
    name: 'test',
    start: async () => {},
    stop: async () => {},
    knows: () => true,
    connect: async () => {
      await answered;
      if (options.discoveryFails) throw new Error('The GATT database could not be read');
      return link;
    },
    drop: async () => void (said.drops += 1),
  };
  return { radio, answer, said };
}

const aChannel = (radio: Radio) => new BleChannel('aabbcc000001', { radio } as never, { gatt: [LAYOUT] } as never, () => {}, { log: () => {} } as never);

describe('a Bluetooth connection on the server', () => {
  test('connects, and says so — and writes to the layout it found', async () => {
    const { radio, answer, said } = aRadio();
    const channel = aChannel(radio);
    answer();
    await channel.connect();
    expect(channel.connected).toBe(true);
    expect(said.drops).toBe(0);
    await channel.write(new Uint8Array([1, 2]));
    expect(said.written).toEqual([new Uint8Array([1, 2])]);
    await channel.close();
  });

  test('closed while it connects: the link it made is let go of, and it never says it is connected', async () => {
    const { radio, answer, said } = aRadio();
    const channel = aChannel(radio);
    const connecting = channel.connect();
    await channel.close();
    const dropsOnClose = said.drops;
    answer();
    await expect(connecting).rejects.toThrow('Closed while connecting');
    expect(channel.connected).toBe(false);
    expect(said.drops).toBe(dropsOnClose + 1);
  });

  test('a step after the link is made that throws lets go of the link', async () => {
    const { radio, answer, said } = aRadio({ discoveryFails: true });
    const channel = aChannel(radio);
    answer();
    await expect(channel.connect()).rejects.toThrow('could not be read');
    expect(said.drops).toBe(1);
    await channel.close();
  });
});
