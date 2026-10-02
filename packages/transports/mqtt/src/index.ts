import type { TransportDefinition } from '@kraftverk/device-sdk';

/**
 * MQTT through kraftverk's own broker (docs/BROKER.md): what the transport is,
 * the same everywhere. It runs only on the server, because only the server has
 * the broker — which is why a method over it is only ever offered as "through
 * your server".
 */
const definition: TransportDefinition = {
  id: 'mqtt',
  label: 'the MQTT broker',
  channel: 'messages',
  // A device's address on the broker is the id its topics name it by: one device.
  exclusive: true,
  nearby: false,
  platforms: ['system'],
  discovery: { system: 'list' },
};

export default definition;
