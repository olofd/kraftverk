import { defineDeviceType, type OpenConnection } from '@kraftverk/device-sdk';
import { linkOver, parseMac, readInputRegisters, stationIdentity } from '@kraftverk/protocol-sydpower';

import { describeStation } from './index.ts';
import { StationClient } from './model/client.ts';
import { INPUT_REGISTER_COUNT, decodeTelemetry } from './model/registers.ts';
import { SimulatedStation } from './simulator.ts';
import { registerTools, stationSession, stationTools } from './station.ts';

/**
 * The AFERIY P280, as a device type: what the holder of its connection
 * discovers in this package, and what the add flow lists under Power stations
 * (docs/ARCHITECTURE.md §4).
 *
 * Two ways to reach one, both the Sydpower protocol: over Wi-Fi, through the
 * MQTT broker the station is pointed at, and over Bluetooth. Where each can be
 * held — the server's broker and radio, or the app's own Bluetooth — follows
 * from the transports, not from anything said here.
 */

/** The station's own id, when the address is one: a MAC over the broker, and as a server's Bluetooth peripheral id. */
const identityFrom = (address: string): string | null => {
  const mac = parseMac(address);
  return mac ? stationIdentity(mac) : null;
};

export default defineDeviceType({
  id: 'aferiy.p280',
  kind: 'hardware',
  meta: {
    name: 'AFERIY P280',
    brand: 'AFERIY',
    models: ['P280', 'AFERIY P280'],
    category: 'power-station',
    description: 'A 2 kWh power station on the Sydpower stack.',
    support: 'verified',
    supportNote: 'Every setting confirmed on real hardware.',
    icon: 'zap',
  },
  config: { fields: {} },
  describe: () => describeStation(),
  connections: [
    {
      id: 'wifi',
      label: 'Wi-Fi',
      description: 'Always on: history and automations keep running. The station must be set to use this server’s broker.',
      protocol: 'sydpower',
      transport: 'mqtt',
      recommended: true,
    },
    {
      id: 'bluetooth',
      label: 'Bluetooth',
      description: 'Within about 10 m of whatever holds it. The station takes one Bluetooth connection at a time.',
      protocol: 'sydpower',
      transport: 'ble',
    },
  ],
  setup: {
    saveAnyway: 'A station that is asleep, or not on Wi-Fi yet, connects when it wakes — its card says so until then.',
  },

  /**
   * Reads the station's telemetry once. Its identity is the MAC it is known by
   * — the broker's topics name it, and a server's radio sees it — and a
   * browser, which hides the MAC, gets none: the check step then asks which
   * of your stations it is.
   */
  async identify(connection: OpenConnection) {
    const link = linkOver(connection);
    try {
      const frame = await link.request(readInputRegisters(0, INPUT_REGISTER_COUNT), 'input', 10_000);
      if (frame.kind !== 'registers' || frame.values.length < 60) {
        return { identity: identityFrom(connection.address), model: 'P280', summary: 'It answered, but its telemetry could not be read.' };
      }
      const telemetry = decodeTelemetry(frame.values);
      const flow =
        telemetry.totalInputWatts > 5
          ? `charging ${Math.round(telemetry.totalInputWatts)} W`
          : telemetry.totalOutputWatts > 5
            ? `supplying ${Math.round(telemetry.totalOutputWatts)} W`
            : 'idle';
      return {
        identity: identityFrom(connection.address),
        model: 'P280',
        summary: `Battery ${Math.round(telemetry.socPercent)} %, ${flow}.`,
      };
    } finally {
      // The channel stays open: it belongs to whoever opened it.
      await link.close().catch(() => undefined);
    }
  },

  async createSession(ctx) {
    const connection = ctx.connection;
    if (!connection) throw new Error('A P280 session needs a connection');
    const link = linkOver(connection);
    const client = new StationClient({ transport: link, readOnly: ctx.readOnly, model: 'AFERIY P280' });
    await client.start();
    return stationSession(client, {
      identity: identityFrom(connection.address),
      connected: () => link.connected,
      advanced: { ...stationTools(client), ...registerTools(client, link, ctx) },
      close: async () => {
        await client.stop();
        await link.close();
      },
    });
  },

  async createSimulator(ctx) {
    const station = new SimulatedStation(ctx.store);
    station.start();
    return stationSession(station, {
      identity: 'sydpower:SIMULATED',
      connected: () => true,
      advanced: stationTools(station),
      close: () => station.stop(),
    });
  },
});
