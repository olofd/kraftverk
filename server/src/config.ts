import { resolve } from 'node:path';

import { allowedHosts } from './auth/host.ts';

/**
 * Everything the server reads from its environment and command line, read once.
 *
 * Kept apart from startup so that the app can be built from a plain object —
 * which is what lets tests construct it without a broker, a radio or the
 * process's own environment.
 *
 * Nothing here says which transports to use: every installed transport is
 * available, and what reaches a device is how you added it — over Wi-Fi, over
 * Bluetooth, or simulated. What each transport needs — where the broker
 * listens, say — is not here either: a transport reads its own settings from
 * the environment it is handed.
 */
export type ServerConfig = {
  port: number;
  host: string;
  /** Block every write to hardware. Use when bringing up an unfamiliar device. */
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

export function loadConfig(env: Record<string, string | undefined> = process.env, argv: string[] = process.argv): ServerConfig {
  return {
    port: Number(env.PORT ?? 3333),
    host: env.HOST ?? '0.0.0.0',
    readOnly: argv.includes('--read-only') || env.READ_ONLY === '1',
    allowRawFrames: env.ALLOW_RAW_FRAMES === '1',
    allowedOrigins: allowedOrigins(env.ALLOWED_ORIGINS),
    allowedHosts: allowedHosts(env),
    development: env.NODE_ENV !== 'production',
    trustedProxies: env.KRAFTVERK_TRUSTED_PROXIES,
    logDir: env.KRAFTVERK_LOG_DIR || resolve(import.meta.dirname, '../data/logs'),
    env,
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
