import { resolve } from 'node:path';

import { allowedHosts } from './auth/host.ts';
import { DEFAULTS as BROKER_DEFAULTS } from './broker/shared.ts';
import type { ServerTransportKind } from './transport/types.ts';

/**
 * Everything the server reads from its environment and command line, read once.
 *
 * Kept apart from startup so that the app can be built from a plain object —
 * which is what lets tests construct it without a broker, a radio or the
 * process's own environment.
 */
export type ServerConfig = {
  port: number;
  host: string;
  /** Which transports this server offers; empty means the simulator. */
  transports: ServerTransportKind[];
  simulate: boolean;
  /** Block every write. Use when bringing up an unfamiliar station. */
  readOnly: boolean;
  /** Bind the first station discovered instead of waiting for a choice. */
  autoBind: boolean;
  /** `--device=`: a station id to bind at startup. */
  deviceId: string | null;
  /** `--for=`: the saved device that `--device` is for. */
  deviceFor: string | null;
  /** Origins allowed to call the API from a browser with credentials. */
  allowedOrigins: string[];
  /** Public names this server answers to (`KRAFTVERK_ALLOWED_HOSTS`, and the hosts of those origins). */
  allowedHosts: Set<string>;
  /** Development: the Expo dev server's origins are allowed too. */
  development: boolean;
  /** Raw MODBUS frames, which can reach undocumented registers. */
  allowRawModbus: boolean;
  /** Where register baselines are kept. */
  baselineFile: string;
  mqtt: {
    /** Where the broker listens for stations. */
    host: string;
    port: number;
    /** Where this server reaches the broker. */
    brokerHost: string;
    adminUrl: string;
    adminPort: number;
    /** Start a broker when none is running. `0` where it runs as its own service. */
    spawn: boolean;
    logLevel: string;
  };
  trustedProxies: string | undefined;
  logDir: string;
};

const flagIn = (argv: string[]) => (name: string) =>
  argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');

export function loadConfig(env: Record<string, string | undefined> = process.env, argv: string[] = process.argv): ServerConfig {
  const flag = flagIn(argv);

  /**
   * Which transports this server offers.
   *
   * `sim` replaces both with the simulator. Anything else is a comma-separated
   * list — `ble`, `mqtt`, or `ble,mqtt` — and the default is *both*, because
   * they are independent resources: the broker is a TCP listener and noble is
   * a radio. Which one a given station is reached over is a property of that
   * station's record, so a server holding one of each is an ordinary state
   * rather than a configuration nobody chose.
   *
   * `device` means "the real station, however it is reachable" — it expands to
   * both radios rather than to `mqtt` alone. Asking for hardware and silently
   * getting only half of it is a trap: the Bluetooth station never appears and
   * the screen looks broken. A machine without a radio is not a problem here,
   * because a transport that fails to start is recorded and reported.
   */
  const driver = flag('driver') ?? env.STATION_DRIVER ?? 'sim';
  const transports: ServerTransportKind[] =
    driver === 'sim'
      ? []
      : [
          ...new Set(
            driver
              .split(',')
              .map((name) => name.trim())
              .flatMap((name) => (name === 'device' ? ['ble', 'mqtt'] : [name]))
              .filter((name): name is ServerTransportKind => name === 'ble' || name === 'mqtt')
          ),
        ];

  const mqttPort = Number(env.MQTT_PORT ?? BROKER_DEFAULTS.mqttPort);
  const mqttHost = env.MQTT_HOST ?? BROKER_DEFAULTS.mqttHost;
  const adminPort = Number(env.BROKER_ADMIN_PORT ?? BROKER_DEFAULTS.adminPort);

  return {
    port: Number(env.PORT ?? 3333),
    host: env.HOST ?? '0.0.0.0',
    transports,
    simulate: transports.length === 0,
    readOnly: argv.includes('--read-only') || env.READ_ONLY === '1',
    autoBind: env.AUTO_BIND !== '0',
    deviceId: flag('device') ?? env.DEVICE_ID ?? env.DEVICE_MAC ?? null,
    deviceFor: flag('for') ?? env.DEVICE_FOR ?? null,
    allowedOrigins: allowedOrigins(env.ALLOWED_ORIGINS),
    allowedHosts: allowedHosts(env),
    development: env.NODE_ENV !== 'production',
    allowRawModbus: env.ALLOW_RAW_MODBUS === '1',
    /*
      Overridable for the same reason `KRAFTVERK_DB` is: in a container the
      source tree is a read-only image layer, and a baseline written there
      would vanish on the next restart.
    */
    baselineFile: env.KRAFTVERK_BASELINE_FILE || resolve(import.meta.dirname, '../data/baseline.json'),
    mqtt: {
      host: mqttHost,
      port: mqttPort,
      /*
        The same machine unless the broker is its own container, in which case
        compose sets it. Loopback when the broker listens on every interface —
        but a broker bound to one LAN address is not on loopback at all.
      */
      brokerHost: env.BROKER_HOST ?? (['0.0.0.0', '::', ''].includes(mqttHost) ? '127.0.0.1' : mqttHost),
      adminPort,
      adminUrl: env.BROKER_ADMIN_URL ?? `http://127.0.0.1:${adminPort}`,
      spawn: env.BROKER_SPAWN !== '0',
      // Its console goes to a file nobody watches, and the journal already
      // holds everything; errors are enough there to explain a crash.
      logLevel: env.BROKER_LOG_LEVEL ?? 'error',
    },
    trustedProxies: env.KRAFTVERK_TRUSTED_PROXIES,
    logDir: env.KRAFTVERK_LOG_DIR || resolve(import.meta.dirname, '../data/logs'),
  };
}

function allowedOrigins(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => {
      if (entry !== '*') return Boolean(entry);
      /*
        Refused, not honoured. With credentialed CORS, `*` means every website
        may make requests *as the signed-in user* and read the answers — the
        session cookie would be anyone's.
      */
      console.error('[server] ALLOWED_ORIGINS=* is ignored: with sign-in, it would hand every website your session.');
      return false;
    });
}
