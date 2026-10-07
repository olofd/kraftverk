import { describe, expect, test } from 'bun:test';

import { BluezRadio, type BusLike, type Signal } from './bluez.ts';
import type { Advert } from './radio.ts';

/*
  BlueZ, played: its objects under /org/bluez as GetManagedObjects lists
  them, and what it tells by signal — a device heard, its advertisement
  changing, a connection made and resolved, a notification, a connection
  lost. Variants as dbus-next gives them: { signature, value }. Made-up
  addresses.
*/

const ADAPTER = '/org/bluez/hci0';
const DEVICE = `${ADAPTER}/dev_AA_BB_CC_00_00_01`;
const SERVICE = `${DEVICE}/service0010`;
const NOTIFY = `${SERVICE}/char0011`;
const WRITE = `${SERVICE}/char0014`;
const v = (signature: string, value: unknown) => ({ signature, value });

function aBluez(options: { powered?: boolean } = {}) {
  const listeners = new Set<(signal: Signal) => void>();
  const calls: string[] = [];
  const written: { path: string; bytes: number[]; type: unknown }[] = [];
  const state = { powered: options.powered ?? true, connected: false };
  const tell = (signal: Signal) => listeners.forEach((listener) => listener(signal));
  const changed = (path: string, iface: string, props: Record<string, unknown>) => tell({ path, iface: 'org.freedesktop.DBus.Properties', member: 'PropertiesChanged', body: [iface, props, []] });

  const objects = (): Record<string, Record<string, Record<string, unknown>>> => ({
    [ADAPTER]: { 'org.bluez.Adapter1': { Powered: v('b', state.powered), Address: v('s', '04:00:00:00:00:01') } },
    [DEVICE]: { 'org.bluez.Device1': { Address: v('s', 'AA:BB:CC:00:00:01'), Name: v('s', 'POWER-0543'), RSSI: v('n', -61), UUIDs: v('as', ['0000fff0-0000-1000-8000-00805f9b34fb']), ManufacturerData: v('a{qv}', { 2504: v('ay', new Uint8Array([0x01, 0x02])) }), Connected: v('b', state.connected) } },
    ...(state.connected
      ? {
          [SERVICE]: { 'org.bluez.GattService1': { UUID: v('s', '0000fff0-0000-1000-8000-00805f9b34fb') } },
          [NOTIFY]: { 'org.bluez.GattCharacteristic1': { UUID: v('s', '0000fff1-0000-1000-8000-00805f9b34fb'), Flags: v('as', ['notify']) } },
          [WRITE]: { 'org.bluez.GattCharacteristic1': { UUID: v('s', '0000fff2-0000-1000-8000-00805f9b34fb'), Flags: v('as', ['write', 'write-without-response']) } },
        }
      : {}),
  });

  const bus: BusLike = {
    async call(path, iface, member, _signature, body) {
      calls.push(`${iface.split('.').pop()}.${member} ${path}`);
      if (member === 'GetManagedObjects') return objects();
      if (member === 'Set' && body?.[1] === 'Powered') state.powered = (body[2] as { value: boolean }).value;
      if (member === 'Connect') {
        state.connected = true;
        // BlueZ says it is connected, and — its services read — resolved.
        setTimeout(() => changed(DEVICE, 'org.bluez.Device1', { Connected: v('b', true), ServicesResolved: v('b', true) }), 5);
      }
      if (member === 'Get' && body?.[1] === 'ServicesResolved') return v('b', state.connected);
      if (member === 'WriteValue') written.push({ path, bytes: [...(body![0] as Uint8Array)], type: (body![1] as Record<string, { value: unknown }>).type?.value });
      if (member === 'Disconnect') {
        state.connected = false;
        changed(DEVICE, 'org.bluez.Device1', { Connected: v('b', false), ServicesResolved: v('b', false) });
      }
      return undefined;
    },
    onSignal(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    variant: v,
    close: () => {},
  };
  return { bus, calls, written, state, tell, changed };
}

describe('Bluetooth through BlueZ', () => {
  test('scans for low energy, every advertisement told: a device as BlueZ knows it, then as it changes', async () => {
    const bluez = aBluez({ powered: false });
    const radio = new BluezRadio(async () => bluez.bus);
    const heard: Advert[] = [];
    await radio.start((advert) => heard.push(advert));
    // Switched on, filtered to low energy with duplicates, and discovering.
    expect(bluez.state.powered).toBe(true);
    expect(bluez.calls).toContain(`Adapter1.SetDiscoveryFilter ${ADAPTER}`);
    expect(bluez.calls).toContain(`Adapter1.StartDiscovery ${ADAPTER}`);
    expect(radio.knows('aabbcc000001')).toBe(true);

    bluez.changed(DEVICE, 'org.bluez.Device1', { RSSI: v('n', -55) });
    expect(heard).toEqual([
      {
        id: 'aabbcc000001',
        name: 'POWER-0543',
        rssi: -55,
        services: ['0000fff0-0000-1000-8000-00805f9b34fb'],
        // Company 0x09c8, as manufacturerOf reads it: by its id, the data in hex.
        manufacturer: { '2504': '0102' },
      },
    ]);

    // One heard for the first time.
    bluez.tell({ path: '/', iface: 'org.freedesktop.DBus.ObjectManager', member: 'InterfacesAdded', body: [`${ADAPTER}/dev_AA_BB_CC_00_00_02`, { 'org.bluez.Device1': { Address: v('s', 'AA:BB:CC:00:00:02'), RSSI: v('n', -80) } }] });
    expect(heard.at(-1)).toMatchObject({ id: 'aabbcc000002', name: null, rssi: -80 });
    await radio.stop();
  });

  test('connects: its services resolved, notifications heard, written with or without a response — and its loss told', async () => {
    const bluez = aBluez();
    const radio = new BluezRadio(async () => bluez.bus);
    await radio.start(() => {});
    const link = await radio.connect('aabbcc000001');
    expect(link.gatt).toEqual({
      services: ['0000fff0-0000-1000-8000-00805f9b34fb'],
      characteristics: [
        { uuid: '0000fff1-0000-1000-8000-00805f9b34fb', properties: ['notify'] },
        { uuid: '0000fff2-0000-1000-8000-00805f9b34fb', properties: ['write', 'write-without-response'] },
      ],
    });

    const received: number[][] = [];
    await link.subscribe('0000fff1-0000-1000-8000-00805f9b34fb', (bytes) => received.push([...bytes]));
    expect(bluez.calls).toContain(`GattCharacteristic1.StartNotify ${NOTIFY}`);
    bluez.changed(NOTIFY, 'org.bluez.GattCharacteristic1', { Value: v('ay', new Uint8Array([0xa5, 0x01])) });
    expect(received).toEqual([[0xa5, 0x01]]);

    await link.write('0000fff2-0000-1000-8000-00805f9b34fb', new Uint8Array([0x01, 0x03]), true);
    await link.write('0000fff2-0000-1000-8000-00805f9b34fb', new Uint8Array([0x02]), false);
    expect(bluez.written).toEqual([
      { path: WRITE, bytes: [0x01, 0x03], type: 'request' },
      { path: WRITE, bytes: [0x02], type: 'command' },
    ]);

    let lost = 0;
    link.onDisconnect(() => (lost += 1));
    bluez.changed(DEVICE, 'org.bluez.Device1', { Connected: v('b', false) });
    expect(lost).toBe(1);
    // Gone, nothing more is heard from it.
    bluez.changed(NOTIFY, 'org.bluez.GattCharacteristic1', { Value: v('ay', new Uint8Array([0xff])) });
    expect(received).toEqual([[0xa5, 0x01]]);
    await radio.stop();
  });

  test('one not heard is not in range; no adapter, and no bus, are said', async () => {
    const bluez = aBluez();
    const radio = new BluezRadio(async () => bluez.bus);
    await radio.start(() => {});
    expect(radio.knows('aabbcc0000ff')).toBe(false);
    await expect(radio.connect('aabbcc0000ff')).rejects.toThrow('not in range');

    const bare: BusLike = { ...bluez.bus, call: async (_path, _iface, member) => (member === 'GetManagedObjects' ? {} : undefined) };
    await expect(new BluezRadio(async () => bare).start(() => {})).rejects.toThrow('has no Bluetooth adapter');
    await expect(new BluezRadio(() => Promise.reject(new Error('ENOENT'))).start(() => {})).rejects.toThrow('is /run/dbus mounted?');
  });
});
