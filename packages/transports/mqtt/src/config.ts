import { networkInterfaces } from 'node:os';

import { brokerDir, DEFAULTS } from './broker/shared.ts';

/**
 * Where the broker is, and whether this server may start one: read from the
 * environment, by this transport, once.
 *
 *   MQTT_HOST / MQTT_PORT     where devices connect (0.0.0.0:1883)
 *   MQTT_ADVERTISED_HOST      the address devices are told to use; found from
 *                             this machine's network otherwise
 *   BROKER_HOST               where the server reaches the broker; loopback
 *                             unless the broker is its own container
 *   BROKER_ADMIN_URL / _PORT  the broker's admin API
 *   BROKER_SPAWN              0 where the broker runs as its own service
 *   BROKER_LOG_LEVEL          a started broker's console verbosity (error)
 *   KRAFTVERK_BROKER_DIR      its token, state and logs
 */
export type MqttTransportConfig = {
  /** Where the broker listens for devices. */
  host: string;
  port: number;
  /** Where this server reaches the broker. */
  brokerHost: string;
  adminUrl: string;
  adminPort: number;
  /** Start a broker when none is running. `0` where it runs as its own service. */
  spawn: boolean;
  logLevel: string;
  dir: string;
  /** What a device is told to connect to, in setup instructions. */
  advertisedHost: string | null;
};

/** This machine's first private IPv4 address, for telling a device where to connect. */
function lanAddress(): string | null {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) return address.address;
    }
  }
  return null;
}

export function mqttConfig(env: Readonly<Record<string, string | undefined>>): MqttTransportConfig {
  const port = Number(env.MQTT_PORT ?? DEFAULTS.mqttPort);
  const host = env.MQTT_HOST ?? DEFAULTS.mqttHost;
  const adminPort = Number(env.BROKER_ADMIN_PORT ?? DEFAULTS.adminPort);
  const everywhere = ['0.0.0.0', '::', ''].includes(host);
  return {
    host,
    port,
    /*
      The same machine unless the broker is its own container, in which case
      compose sets it. Loopback when the broker listens on every interface —
      but a broker bound to one LAN address is not on loopback at all.
    */
    brokerHost: env.BROKER_HOST ?? (everywhere ? '127.0.0.1' : host),
    adminPort,
    adminUrl: env.BROKER_ADMIN_URL ?? `http://127.0.0.1:${adminPort}`,
    spawn: env.BROKER_SPAWN !== '0',
    // Its console goes to a file nobody watches, and the journal already
    // holds everything; errors are enough there to explain a crash.
    logLevel: env.BROKER_LOG_LEVEL ?? 'error',
    dir: env.KRAFTVERK_BROKER_DIR || brokerDir(),
    /*
      In a container this machine's own address is the container's, which is
      no use to a device on the LAN — so there it has to be said.
    */
    advertisedHost: env.MQTT_ADVERTISED_HOST || (everywhere ? lanAddress() : host),
  };
}
