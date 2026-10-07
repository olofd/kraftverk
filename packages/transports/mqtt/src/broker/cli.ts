import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { duration, formatEntry, atLeast } from './journal.ts';
import { brokerBuild, brokerDir, brokerToken, DEFAULTS, paths, type JournalEntry, type JournalLevel, type DevicePresence } from './shared.ts';
import { BrokerSupervisor, probeHealth } from './supervisor.ts';

/**
 * `npm run broker -- <command>`: the broker, from a terminal.
 *
 *   status              is it running, which build, who is connected
 *   start               start it detached, unless it already runs
 *   stop                stop it — this drops every device on it
 *   restart             stop, then start: how to load new broker code
 *   logs [-f] [-n 50]   the journal; -f follows, --debug adds every frame,
 *                       --device=<address> narrows to one device
 *   run                 run it in this terminal, in the foreground
 */

const [command = 'status', ...rest] = process.argv.slice(2);
const dir = brokerDir();
const files = paths(dir);
const flag = (name: string) => rest.find((arg) => arg.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const has = (...names: string[]) => names.some((name) => rest.includes(name));

/** The admin API: from the environment, else where the running broker said it was, else the default. */
function adminUrl(): string {
  if (process.env.BROKER_ADMIN_URL) return process.env.BROKER_ADMIN_URL;
  try {
    const state = JSON.parse(readFileSync(files.state, 'utf8')) as { admin?: { host: string; port: number } };
    if (state.admin) return `http://${state.admin.host === '0.0.0.0' ? '127.0.0.1' : state.admin.host}:${state.admin.port}`;
  } catch {
    // No state file: nothing has run from this directory, or it stopped cleanly.
  }
  return `http://127.0.0.1:${process.env.BROKER_ADMIN_PORT ?? DEFAULTS.adminPort}`;
}

const mqttPort = Number(process.env.MQTT_PORT || DEFAULTS.mqttPort);
const mqttHost = process.env.MQTT_HOST || DEFAULTS.mqttHost;

// The same choices the server makes when it starts one — see `src/index.ts`.
function supervisor(): BrokerSupervisor {
  return new BrokerSupervisor({
    adminUrl: adminUrl(),
    mqtt: { host: ['0.0.0.0', '::'].includes(mqttHost) ? '127.0.0.1' : mqttHost, port: mqttPort },
    spawn: true,
    dir,
    env: {
      MQTT_HOST: mqttHost,
      MQTT_PORT: String(mqttPort),
      BROKER_ADMIN_PORT: process.env.BROKER_ADMIN_PORT || String(DEFAULTS.adminPort),
      BROKER_LOG_LEVEL: process.env.BROKER_LOG_LEVEL || 'error',
    },
    log: (message) => console.log(message),
  });
}

async function admin<T>(path: string, init?: RequestInit): Promise<T | null> {
  try {
    const response = await fetch(`${adminUrl()}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${brokerToken(dir)}` },
      signal: AbortSignal.timeout(3000),
    });
    return response.ok ? ((await response.json()) as T) : null;
  } catch {
    return null;
  }
}

async function status(): Promise<number> {
  const health = await probeHealth(adminUrl());
  if (!health) {
    console.log(`No broker is answering at ${adminUrl()}.`);
    console.log('The server starts one when it needs it, or run `npm run broker:start`.');
    // Not a failure: "nothing is running" is a perfectly good answer to "status",
    // and a non-zero exit makes npm bury it under a page of lifecycle errors.
    return 0;
  }

  const expected = brokerBuild();
  console.log(`Broker pid ${health.pid}, up ${duration(health.uptimeMs)} (since ${new Date(health.startedAt).toLocaleString()})`);
  console.log(`  build     ${health.build}${health.build === expected ? ' (matches the code on disk)' : ` — the code on disk is ${expected}; \`npm run broker:restart\` loads it, and drops every device while it does`}`);
  console.log(`  devices   connect to ${health.mqtt.host}:${health.mqtt.port} (${health.mqtt.listening ? 'listening' : 'NOT listening'})`);
  console.log(`  admin     ${adminUrl()}`);
  console.log(`  runtime   ${health.runtime}`);
  console.log(`  journal   ${files.logs}`);

  type Status = {
    devices: (DevicePresence & { messagesIn: number; commandsOut: number; unpromptedPushes: number; pushIntervalMs: number | null })[];
    clients: { clientId: string | null; remote: string; role: string; openForMs: number; keepalive: number | null }[];
    counters: Record<string, number>;
  };
  const detail = await admin<Status>('/status');
  if (!detail) {
    console.log('\n(Could not read the details: the token in this directory is not the one the broker uses.)');
    return 0;
  }

  console.log('\nDevices');
  if (detail.devices.length === 0) console.log('  none seen yet');
  for (const s of detail.devices) {
    const line = s.online
      ? `online from ${s.remote} since ${time(s.connectedAt)} (keepalive ${s.keepalive ?? '?'} s${s.subscribed ? '' : ', NOT subscribed to its command topic'})`
      : `offline${s.disconnectedAt ? ` since ${time(s.disconnectedAt)}` : ''}${s.lastDisconnect ? ` — ${s.lastDisconnect}` : ''}`;
    console.log(`  ${s.address} (${s.protocol})  ${line}`);
    console.log(`                ${s.sessions} session(s) this run, ${s.messagesIn} frames in, ${s.commandsOut} commands out, ${s.unpromptedPushes} unprompted pushes${s.pushIntervalMs ? ` (every ~${duration(s.pushIntervalMs)})` : ''}`);
  }

  console.log('\nClients');
  if (detail.clients.length === 0) console.log('  none connected');
  for (const c of detail.clients) {
    console.log(`  ${c.role.padEnd(11)} ${(c.clientId ?? '—').padEnd(28)} ${c.remote.padEnd(22)} open ${duration(c.openForMs)}`);
  }
  const n = detail.counters;
  console.log(
    `\nThis run: ${n.connections} connections, ${n.messagesIn} frames in, ${n.commandsOut} commands out` +
      `${n.commandsUndelivered ? ` (${n.commandsUndelivered} went nowhere)` : ''}, ${n.refused} publishes refused`
  );
  return 0;
}

async function stop(): Promise<boolean> {
  const health = await probeHealth(adminUrl());
  if (!health) {
    console.log('No broker is running.');
    return true;
  }
  // Asked before stopping: a server that is connected will start a new broker
  // within seconds, which is its job — and would make "stop" look broken.
  const detail = await admin<{ clients: { role: string }[] }>('/status');
  const servers = detail?.clients.filter((client) => client.role === 'server').length ?? 0;

  if (!(await admin(`/shutdown?reason=${encodeURIComponent(`npm run broker:${command}`)}`, { method: 'POST' }))) {
    console.error('The broker refused to stop: the token here is not the one it uses.');
    return false;
  }
  for (let i = 0; i < 50; i++) {
    if (!(await probeHealth(adminUrl(), 300))) {
      console.log(`Stopped the broker (pid ${health.pid}). Devices on it are disconnected until one runs again.`);
      if (servers > 0 && command === 'stop') {
        console.log(
          'A kraftverk server is connected to it, and will start a new broker within a few seconds — ' +
            'keeping one running is its job. To keep the broker stopped, stop the server first.'
        );
      }
      return true;
    }
    await Bun.sleep(100);
  }
  console.error(`The broker (pid ${health.pid}) did not stop within 5 s.`);
  return false;
}

async function start(): Promise<number> {
  const state = await supervisor().ensure();
  if (state.status !== 'running' || !state.health) {
    console.error(state.error ?? 'The broker did not start.');
    return 1;
  }
  if (!state.started) console.log(`Already running: pid ${state.health.pid}.`);
  return 0;
}

/** Journal files, oldest first. */
function journalFiles(): string[] {
  if (!existsSync(files.logs)) return [];
  return readdirSync(files.logs)
    .filter((name) => /^broker-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
    .sort()
    .map((name) => join(files.logs, name));
}

const readEntries = (file: string) => parseLines(readFileSync(file, 'utf8'));

const LEVELS: JournalLevel[] = ['debug', 'info', 'warn', 'error'];

async function logs(): Promise<number> {
  const asked = flag('level');
  if (asked && !LEVELS.includes(asked as JournalLevel)) {
    console.error(`--level must be one of ${LEVELS.join(', ')}.`);
    return 2;
  }
  const level: JournalLevel = has('--debug', '-d') ? 'debug' : ((asked as JournalLevel | undefined) ?? 'info');
  const device = flag('device');
  const count = Number(flag('n') ?? (rest.includes('-n') ? rest[rest.indexOf('-n') + 1] : undefined) ?? 50) || 50;
  const wanted = (entry: JournalEntry) => atLeast(entry.level, level) && (!device || entry.device === device);
  const show = (entry: JournalEntry) => console.log(formatEntry(entry));

  const all = journalFiles();
  if (all.length === 0) {
    console.log(`No journal yet in ${files.logs}. It starts with the broker.`);
    if (!has('-f', '--follow')) return 0;
  }

  // The last `count` wanted entries, reaching back into yesterday's file if today's is short.
  const recent: JournalEntry[] = [];
  for (const file of [...all].reverse()) {
    recent.unshift(...readEntries(file).filter(wanted));
    if (recent.length >= count) break;
  }
  recent.slice(-count).forEach(show);

  if (!has('-f', '--follow')) return 0;

  let file = all.at(-1) ?? null;
  let offset = file ? statSync(file).size : 0;

  /** Prints whole lines written to `file` since `offset`, and moves past them. */
  const drain = () => {
    if (!file) return;
    const size = statSync(file).size;
    if (size <= offset) return;
    // Only the new bytes: by evening, at debug volume, the whole file is tens of MB.
    const bytes = Buffer.alloc(size - offset);
    const fd = openSync(file, 'r');
    try {
      readSync(fd, bytes, 0, bytes.length, offset);
    } finally {
      closeSync(fd);
    }
    const complete = bytes.subarray(0, bytes.lastIndexOf(0x0a) + 1);
    offset += complete.length;
    for (const entry of parseLines(complete.toString('utf8'))) if (wanted(entry)) show(entry);
  };

  for (;;) {
    await Bun.sleep(500);
    const latest = journalFiles().at(-1) ?? null;
    if (latest !== file) {
      // Midnight: the broker moved on to a new file. Finish the old one first,
      // or its last lines before the switch are never shown.
      drain();
      file = latest;
      offset = 0;
    }
    drain();
  }
}

function parseLines(text: string): JournalEntry[] {
  const entries: JournalEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as JournalEntry);
    } catch {
      // A line still being written, or damaged; not worth stopping for.
    }
  }
  return entries;
}

function time(iso: string | null): string {
  return iso ? new Date(iso).toLocaleTimeString() : '?';
}

switch (command) {
  case 'status':
    process.exit(await status());
  case 'start':
    process.exit(await start());
  case 'stop':
    process.exit((await stop()) ? 0 : 1);
  case 'restart': {
    if (!(await stop())) process.exit(1);
    process.exit(await start());
  }
  case 'logs':
    process.exit(await logs());
  case 'run':
    process.env.BROKER_LOG_LEVEL ??= has('--debug', '-d') ? 'debug' : 'info';
    await import('./main.ts');
    break;
  default:
    console.error(`Unknown command "${command}". Try: status, start, stop, restart, logs [-f] [--debug] [--device=ADDRESS] [-n 50], run`);
    process.exit(2);
}
