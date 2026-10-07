import { heardAs, type Protocol, type Sighting } from '@kraftverk/device-sdk';

import { BASE, brokerPolicy } from './topics.ts';

/**
 * Zigbee2MQTT's protocol (docs/PLAN-ZIGBEE.md §5.1): its MQTT API — the
 * bridge's own topics, each device's state and commands, requests answered
 * with their `transaction` — what a device is from what it exposes, and what
 * the broker applies to all of it. Pure: messages in, messages out.
 */

export * from './wire.ts';
export * from './exposes.ts';
export * from './topics.ts';
export * from './firmware.ts';

const protocol: Protocol = {
  id: 'zigbee2mqtt',
  label: 'Zigbee2MQTT',
  bindings: {
    mqtt: {
      open: () => ({}),
      /** Zigbee2MQTT, connected to this server's broker: the coordinator, offered without anyone asking. */
      recognise(sighting: Sighting) {
        const client = heardAs(sighting, 'client').find((said) => said.protocol === 'zigbee2mqtt');
        if (!client) return null;
        return {
          name: 'Zigbee2MQTT',
          detail: client.online ? 'Zigbee2MQTT is connected to this server' : 'Zigbee2MQTT was connected to this server, and is not now',
        };
      },
      instructions: {
        title: 'Run Zigbee2MQTT beside this server',
        body:
          'Zigbee2MQTT drives the Zigbee USB dongle and speaks to this server’s broker at {host}, port {port}, signed in as zigbee2mqtt. ' +
          'Its deploy starts it with the dongle: see docs/DOCKER.md, Zigbee. It appears in the next step once it connects.',
      },
      /** The base topic, which is fixed. */
      parseAddress: (input) => (input.trim() === BASE ? BASE : null),
      addressLabel: 'Base topic',
      broker: brokerPolicy,
    },
  },
};

export default protocol;
