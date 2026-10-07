import { heardAs, identityOf, type Protocol, type Sighting } from '@kraftverk/device-sdk';

import { isLikelyStation, SERVICE_CANDIDATES } from './ble.ts';
import { commandRefusal } from './guard.ts';
import { brokerPolicy } from './mqtt.ts';

/**
 * The Sydpower protocol: how AFERIY, FOSSiBOT, ABOK and Eco Play power stations
 * are spoken to (docs/ARCHITECTURE.md §3).
 *
 * AFERIY does not write its own firmware stack — it rebadges Sydpower, the
 * platform behind all of these, driven by one vendor app (BrightEMS). The
 * station is a MODBUS RTU slave at address 0x11 with a big-endian CRC, and the
 * same frames travel over MQTT (through a broker the station is pointed at) and
 * over Bluetooth.
 *
 * Pure code: framing, the one rule no frame may break (register 68), the two
 * bindings, and a link that speaks over a channel it is given. What the
 * registers *mean* belongs to each model's device type.
 */

export * from './modbus.ts';
export * from './guard.ts';
export * from './ble.ts';
export * from './mqtt.ts';
export * from './link.ts';

/** A MAC, however it was written: `AA:BB:CC:00:11:22`, `aabbcc001122`. */
export const parseMac = (input: string): string | null => {
  const hex = input.trim().replace(/[:\-\s]/g, '').toUpperCase();
  return /^[0-9A-F]{12}$/.test(hex) ? hex : null;
};

/** The station's permanent identity: its Bluetooth MAC, which it also names itself by over MQTT. */
export const stationIdentity = (mac: string): string => identityOf('sydpower', mac.toUpperCase());

const protocol: Protocol = {
  id: 'sydpower',
  label: 'Sydpower',
  bindings: {
    mqtt: {
      open: () => ({}),
      recognise(sighting: Sighting) {
        const client = heardAs(sighting, 'client').find((said) => said.protocol === 'sydpower');
        if (!client) return null;
        const mac = parseMac(sighting.address);
        if (!mac) return null;
        return {
          name: sighting.name ?? `Station ${mac}`,
          identity: stationIdentity(mac),
          detail: client.online ? 'Connected to this server over Wi-Fi' : 'Seen on Wi-Fi, not connected right now',
        };
      },
      instructions: {
        title: 'Point the station at this server',
        body:
          'Over Wi-Fi the station talks to an MQTT broker instead of the vendor’s cloud, and this server runs one. ' +
          'In BrightEMS, open the station, then Settings → Local MQTT broker, and enter {host}, port {port}. ' +
          'Older firmware without that setting can be caught by pointing mqtt.sydpower.com at {host} in your router. ' +
          'The station appears in the next step once it connects — a sleeping one when you press its power button.',
      },
      parseAddress: parseMac,
      addressLabel: 'MAC address',
      broker: brokerPolicy,
    },
    ble: {
      open: () => ({ gatt: SERVICE_CANDIDATES, writeWithResponse: true }),
      recognise(sighting: Sighting) {
        const services = heardAs(sighting, 'advert').flatMap((advert) => advert.services);
        if (!isLikelyStation({ name: sighting.name ?? null, serviceUuids: services })) return null;
        // A peripheral id that is a MAC is the station's identity; a browser's
        // private handle is not, and the check step reads what it can.
        const mac = parseMac(sighting.address);
        return {
          name: sighting.name ?? 'Power station',
          ...(mac ? { identity: stationIdentity(mac) } : {}),
          detail: typeof sighting.rssi === 'number' ? `Bluetooth, signal ${sighting.rssi} dBm` : 'Bluetooth',
        };
      },
      instructions: {
        title: 'Wake the station',
        body:
          'Turn the station on and stay within a few metres of it. Close BrightEMS on your phone first: ' +
          'the station takes one Bluetooth connection at a time.',
      },
    },
  },
  guard: commandRefusal,
};

export default protocol;
