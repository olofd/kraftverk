import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * What the broker process and the server both need to agree on.
 *
 * The broker runs as its own process so that restarting the server — which
 * happens on every edit during development — does not drop a device. A station
 * has been seen to stop retrying after its broker disappears for a while, and
 * then only a power-cycle brings it back. So the thing the station connects to
 * has to outlive the thing that changes most often.
 *
 * The two halves talk over MQTT, as a privileged client of the broker, plus a
 * small HTTP admin API for diagnostics. Everything here is the contract
 * between them: names, where files live, the shared secret, and a fingerprint
 * of the broker's code so the server can say when the one running is stale.
 */

/** The username the server connects with. Only it may command a device. */
export const SERVER_USERNAME = 'kraftverk-server';

/**
 * Client ids starting with this are refused to anyone but the server.
 *
 * MQTT lets a new connection with an existing client id take over the old one's
 * session. Without this, any device on the LAN could connect as the server's id
 * and knock the server off the broker.
 */
export const RESERVED_CLIENT_PREFIX = 'kraftverk-';

/**
 * Topics the broker publishes for the server, and nobody else may.
 *
 * A leading `$` keeps them out of `#`: by the MQTT spec a wildcard at the first
 * level does not match topics starting with `$`, so a device or a snooping
 * client subscribed to everything does not receive them.
 */
export const TOPIC = {
  /** Retained, one per device: whether it is connected right now. */
  presence: (protocol: string, address: string) => `$kraftverk/device/${protocol}/${address}`,
  presenceFilter: '$kraftverk/device/+/+',
  /** Every journal entry at info level and above, as it happens. */
  journal: '$kraftverk/journal',
  /**
   * Everything devices publish. The server subscribes to all of it, and each
   * connection's protocol picks out its own device's topics.
   */
  everything: '#',
} as const;

export const DEFAULTS = {
  mqttHost: '0.0.0.0',
  mqttPort: 1883,
  /**
   * Loopback only by default. The admin API can shut the broker down, and it is
   * the server's to call, not the LAN's. In Docker the broker's container sets
   * this to 0.0.0.0 so the server's container can reach it — and does not
   * publish the port.
   */
  adminHost: '127.0.0.1',
  adminPort: 3883,
} as const;

/** Where the broker keeps its token, state and logs. */
export function brokerDir(): string {
  return process.env.KRAFTVERK_BROKER_DIR || resolve(import.meta.dirname, '../../../../../server/data/broker');
}

export const paths = (dir = brokerDir()) => ({
  dir,
  token: join(dir, 'token'),
  /** Written by a running broker: its pid and addresses. Removed on a clean stop. */
  state: join(dir, 'broker.json'),
  /** Devices seen by any broker run, so a fresh one knows whom to expect. */
  devices: join(dir, 'devices.json'),
  logs: join(dir, 'logs'),
  /** The broker's own stdout and stderr, for crashes that happen before the journal opens. */
  stdout: join(dir, 'logs', 'stdout.log'),
});

/**
 * The secret the server proves itself with.
 *
 * Created by whichever side needs it first, with an exclusive create so the
 * two cannot each write a different one. `KRAFTVERK_BROKER_TOKEN` overrides the
 * file — for containers that would rather not share a volume.
 */
export function brokerToken(dir = brokerDir()): string {
  const fromEnv = process.env.KRAFTVERK_BROKER_TOKEN?.trim();
  if (fromEnv) return fromEnv;

  const { token } = paths(dir);
  const read = () => {
    try {
      return readFileSync(token, 'utf8').trim();
    } catch {
      return null;
    }
  };

  if (read() === null) {
    mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(token, randomBytes(32).toString('base64url'), { flag: 'wx', mode: 0o600 });
    } catch {
      // The other side won the race. Its token is the one to use.
    }
  }

  /*
    An exclusive create is not an atomic write: the file exists, empty, for the
    moment between the other side creating it and writing it. Reading it then
    and settling for "" would be worse than useless — an empty token matches an
    empty password. So an empty read waits for the writer, briefly.
  */
  for (let attempt = 0; attempt < 50; attempt++) {
    const value = read();
    if (value) return value;
    Bun.sleepSync(20);
  }
  throw new Error(`The broker token at ${token} is empty. Delete it, and it will be created again.`);
}

/**
 * The broker's own clients — a bridge, one client for many devices — by
 * name, each with its password: `KRAFTVERK_BROKER_CLIENTS=<name>=<password>,…`,
 * handed to the broker and to the client by the deploy. A name with an empty
 * password is no client: an empty secret matches nothing (`sameSecret`).
 */
export function brokerClients(text = process.env.KRAFTVERK_BROKER_CLIENTS ?? ''): Map<string, string> {
  const clients = new Map<string, string>();
  for (const entry of text.split(',')) {
    const at = entry.indexOf('=');
    const name = (at < 0 ? '' : entry.slice(0, at)).trim();
    const password = (at < 0 ? '' : entry.slice(at + 1)).trim();
    // The server's name is the server's, whatever the environment says.
    if (name && password && name !== SERVER_USERNAME) clients.set(name, password);
  }
  return clients;
}

/**
 * A fingerprint of the clients a broker lets sign in — names and passwords —
 * so a deploy can tell the running broker was given others than these, and
 * recreate it: a bridge it does not know is a bridge whose devices it
 * refuses. Twelve hex digits of a SHA-256: nothing of a password can be read
 * back from it. The deploy works it out the same way (`scripts/deploy.sh`).
 */
export function clientsFingerprint(clients: ReadonlyMap<string, string>): string {
  const text = [...clients].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([name, password]) => `${name}=${password}`).join(',');
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

/**
 * Compares secrets without leaking, through timing, how much of a guess was right.
 *
 * An empty secret matches nothing — including another empty one. Whatever went
 * wrong to produce it, the answer must not be "anyone may be the server".
 */
export function sameSecret(given: string | Buffer | undefined, expected: string): boolean {
  if (given === undefined || expected.length === 0) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * A fingerprint of the code the broker runs.
 *
 * Read from disk by both sides, so a server restarted onto newer code can tell
 * that the broker still running is the old one. It says so rather than
 * restarting it, because restarting the broker is exactly the event the split
 * exists to avoid: it drops the station.
 */
export function brokerBuild(): string {
  const here = import.meta.dirname;
  /*
    The broker's own files, and every installed integration's protocol
    sources: a policy is code the broker runs, so a changed protocol is a
    changed broker.
  */
  const integrations = resolve(here, '../../../../integrations');
  let protocolFiles: string[] = [];
  try {
    protocolFiles = readdirSync(integrations)
      .sort()
      .flatMap((entry) => {
        try {
          return readdirSync(join(integrations, entry, 'src', 'protocol'))
            .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
            .sort()
            .map((name) => join(integrations, entry, 'src', 'protocol', name));
        } catch {
          return [];
        }
      });
  } catch {
    // No integrations directory: the broker will say so when it starts.
  }
  const files = ['shared.ts', 'policy.ts', 'journal.ts', 'broker.ts', 'admin.ts', 'main.ts'].map((name) => join(here, name)).concat(protocolFiles);
  const hash = createHash('sha256');
  for (const file of files) {
    try {
      // Line endings normalised, so a checkout on Windows and one in a Linux
      // container agree on what "the same code" is.
      hash.update(readFileSync(file, 'utf8').replace(/\r\n/g, '\n'));
    } catch {
      hash.update(`missing:${file}`);
    }
  }
  return hash.digest('hex').slice(0, 12);
}

/** What `GET /health` answers. Unauthenticated, so nothing in it is sensitive. */
export type BrokerHealth = {
  ok: true;
  name: 'kraftverk-broker';
  pid: number;
  startedAt: string;
  uptimeMs: number;
  build: string;
  runtime: string;
  mqtt: { host: string; port: number; listening: boolean };
  admin: { host: string; port: number };
  devicesOnline: number;
  /** The protocols whose policies it applies. */
  protocols: string[];
  /** Which clients may sign in, as a fingerprint (`clientsFingerprint`). */
  clients: string;
};

/** A device as the broker sees it. Retained on its presence topic. */
export type DevicePresence = {
  /** The protocol it speaks, whose policy recognised it. */
  protocol: string;
  /** Its address on the broker: the id its topics name it by. */
  address: string;
  online: boolean;
  clientId: string | null;
  /** Where it connected from, `ip:port`. */
  remote: string | null;
  connectedAt: string | null;
  disconnectedAt: string | null;
  /** Why the last session ended, in words. */
  lastDisconnect: string | null;
  lastMessageAt: string | null;
  /** The keepalive the device asked for, in seconds. */
  keepalive: number | null;
  /** Whether it has subscribed to its command topic — without that, commands go nowhere. */
  subscribed: boolean;
  /** Sessions this broker process has seen from it. */
  sessions: number;
};

export type JournalLevel = 'debug' | 'info' | 'warn' | 'error';

export type JournalEntry = {
  /** Increasing within one broker run. Resets when the broker restarts. */
  seq: number;
  at: string;
  level: JournalLevel;
  /** A stable name for the event, like `device.online` or `command`. */
  kind: string;
  /** A sentence a person can read without the rest. */
  message: string;
  /** The device's address, when the entry is about one. */
  device?: string;
  clientId?: string;
  remote?: string;
  data?: Record<string, unknown>;
};
