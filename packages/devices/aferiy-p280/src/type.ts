import { defineDeviceType, type SetupContext } from '@kraftverk/device-sdk';

import { CAPABILITIES, CONTROLS, DANGEROUS_SETTINGS, MEASUREMENTS, SETTINGS_SCHEMA } from './index.ts';
import { SimulatedStation } from './simulator.ts';
import { STATION_LINKS, stationSession, type StationLinks } from './station.ts';

/**
 * The AFERIY P280, as a device type: what the server discovers in this package
 * and what the app's add screen lists (docs/ARCHITECTURE.md §4).
 */

type P280Config = {
  /** How the server reaches it: Wi-Fi through the broker, or Bluetooth. */
  transport?: 'mqtt' | 'ble';
  /** Which station, by the id its radio or the broker knows it by: a MAC. */
  boundId?: string;
};

const links = (ctx: { transports: SetupContext['transports'] }) => ctx.transports.get<StationLinks & StationSightings>(STATION_LINKS);

/** What the server's transports can see, for the setup guide. */
type StationSightings = {
  discovered(): { id: string; name: string; transport: string; bound: boolean }[];
};

export default defineDeviceType<P280Config>({
  id: 'aferiy.p280',
  apiVersion: '2',
  kind: 'hardware',
  meta: {
    name: 'AFERIY P280',
    brand: 'AFERIY',
    models: ['P280'],
    category: 'power-station',
    description: 'A 2 kWh power station on the Sydpower stack, reached over Wi-Fi through this server, or Bluetooth.',
    support: 'verified',
    supportNote: 'Every setting confirmed on real hardware.',
    icon: 'zap',
  },
  protocols: ['sydpower'],
  capabilities: CAPABILITIES,
  telemetry: MEASUREMENTS,
  controls: CONTROLS,
  settings: { schema: SETTINGS_SCHEMA, dangerous: [...DANGEROUS_SETTINGS] },
  config: {
    fields: {
      transport: {
        type: 'enum',
        title: 'Connection',
        options: [
          { value: 'mqtt', label: 'Wi-Fi, through this server' },
          { value: 'ble', label: 'Bluetooth, from this server' },
        ],
      },
      boundId: { type: 'string', title: 'Station', description: 'The station’s own id: its MAC address.' },
    },
  },
  setup: {
    steps: [
      {
        id: 'wifi',
        kind: 'instructions',
        title: 'Point the station at this server',
        body:
          'Over Wi-Fi, the station connects to this server’s MQTT broker instead of the vendor’s cloud. ' +
          'docs/BROKER.md explains how; once it is done, the station appears in the next step.',
      },
      {
        id: 'find',
        kind: 'discover',
        title: 'Choose your station',
        run: async (ctx) => {
          const seen = links(ctx)?.discovered() ?? [];
          const free = seen.filter((station) => !station.bound);
          if (free.length === 0) {
            return {
              ok: false,
              detail: seen.length
                ? 'Every station this server can see already belongs to a saved device.'
                : 'This server cannot see a station yet. A station that is asleep appears when it wakes.',
            };
          }
          return {
            ok: true,
            detail: `${free.length === 1 ? 'One station' : `${free.length} stations`} found.`,
            choices: free.map((station, index) => ({
              id: station.id,
              label: station.name,
              detail: `${station.id} · ${station.transport === 'ble' ? 'Bluetooth' : 'Wi-Fi'}`,
              config: { transport: station.transport, boundId: station.id },
              recommended: index === 0,
            })),
          };
        },
      },
      {
        id: 'check',
        kind: 'verify',
        title: 'Check that it answers',
        run: async (ctx) => {
          const seen = links(ctx)?.discovered() ?? [];
          const station = seen.find((candidate) => candidate.id.toLowerCase() === String(ctx.draft.boundId ?? '').toLowerCase());
          return station
            ? { ok: true, detail: `${station.name} is reachable.` }
            : { ok: false, detail: 'That station is not answering right now.' };
        },
        saveAnyway: 'A station that is asleep, or not on Wi-Fi yet, connects when it wakes — its card says so until then.',
      },
    ],
  },

  async createSession(ctx) {
    const server = links(ctx);
    return stationSession(
      () => (server ? server.lookup(ctx.deviceId) : { driver: null, reason: 'This server offers no way to reach a station' }),
      { boundId: ctx.config.boundId ?? null }
    );
  },

  async createSimulator(ctx) {
    const station = new SimulatedStation(ctx.store);
    station.start();
    return stationSession(() => ({ driver: station, transport: 'sim' }), { close: () => station.stop() });
  },
});
