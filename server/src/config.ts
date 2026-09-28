import { resolve } from 'node:path';

import type { Availability } from '@kraftverk/device-sdk';

import { allowedHosts } from './auth/host.ts';

/**
 * Everything the server reads from its environment and command line, read once.
 *
 * Kept apart from startup so that the app can be built from a plain object —
 * which is what lets tests construct it without a broker, a radio or the
 * process's own environment.
 *
 * What each transport needs — where the broker listens, say — is not here: a
 * transport reads its own settings from the environment it is handed.
 */
export type ServerConfig = {
  port: number;
  host: string;
  /**
   * Which transports this server may start. Empty with the simulator, which
   * reaches no hardware at all.
   */
  transports: string[];
  simulate: boolean;
  /** Block every write. Use when bringing up an unfamiliar device. */
  readOnly: boolean;
  /**
   * A device type's raw-frame tool may send frames nobody has described, for
   * bringing up an unfamiliar unit. The protocol's guard still applies.
   */
  allowRawFrames: boolean;
  /** Origins allowed to call the API from a browser with credentials. */
  allowedOrigins: string[];
  /** Public names this server answers to (`KRAFTVERK_ALLOWED_HOSTS`, and the hosts of those origins). */
  allowedHosts: Set<string>;
  /** Development: the Expo dev server's origins are allowed too. */
  development: boolean;
  trustedProxies: string | undefined;
  logDir: string;
  /** The environment transports read their own settings from. */
  env: Readonly<Record<string, string | undefined>>;
};

/**
 * Transports that need nothing of the machine: a TCP socket on the home
 * network, and HTTPS. Every server that reaches hardware may use them.
 */
const ALWAYS = ['lan', 'https'];

const flagIn = (argv: string[]) => (name: string) =>
  argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');

/**
 * Which transports this server may start.
 *
 * `KRAFTVERK_TRANSPORTS` names them outright: `mqtt,lan,https`. Otherwise
 * `STATION_DRIVER` (or `--driver=`) says, as it always has: `sim` reaches no
 * hardware; `device` means everything this machine might have; a list —
 * `mqtt`, `ble`, `ble,mqtt` — means those radios, plus the home network and
 * HTTPS, which need nothing a machine might lack. A transport named here that
 * cannot start where it runs — Bluetooth in a container — is reported, not fatal.
 */
export function enabledTransports(env: Readonly<Record<string, string | undefined>>, argv: string[] = []): string[] {
  const explicit = env.KRAFTVERK_TRANSPORTS?.trim();
  if (explicit) return [...new Set(explicit.split(',').map((name) => name.trim()).filter(Boolean))];

  const driver = flagIn(argv)('driver') ?? env.STATION_DRIVER ?? 'sim';
  if (driver === 'sim') return [];
  const radios = driver
    .split(',')
    .map((name) => name.trim())
    .flatMap((name) => (name === 'device' ? ['ble', 'mqtt'] : [name]))
    .filter(Boolean);
  return [...new Set([...radios, ...ALWAYS])];
}

export function loadConfig(env: Record<string, string | undefined> = process.env, argv: string[] = process.argv): ServerConfig {
  const transports = enabledTransports(env, argv);
  return {
    port: Number(env.PORT ?? 3333),
    host: env.HOST ?? '0.0.0.0',
    transports,
    simulate: transports.length === 0,
    readOnly: argv.includes('--read-only') || env.READ_ONLY === '1',
    // ALLOW_RAW_MODBUS is the name it had while the station was the only device.
    allowRawFrames: env.ALLOW_RAW_FRAMES === '1' || env.ALLOW_RAW_MODBUS === '1',
    allowedOrigins: allowedOrigins(env.ALLOWED_ORIGINS),
    allowedHosts: allowedHosts(env),
    development: env.NODE_ENV !== 'production',
    trustedProxies: env.KRAFTVERK_TRUSTED_PROXIES,
    logDir: env.KRAFTVERK_LOG_DIR || resolve(import.meta.dirname, '../data/logs'),
    env,
  };
}

/** Whether this server may use a transport, and if not, why — for the add screen. */
export const transportEnabled =
  (config: Pick<ServerConfig, 'transports' | 'simulate'>) =>
  (id: string): Availability =>
    config.simulate
      ? { ok: false, reason: 'This server runs the simulator, and reaches no hardware' }
      : config.transports.includes(id)
        ? { ok: true }
        : { ok: false, reason: `This server was not started with ${id} (KRAFTVERK_TRANSPORTS)` };

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
