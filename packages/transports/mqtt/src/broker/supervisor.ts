import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';

import { brokerBuild, paths, type BrokerHealth } from './shared.ts';

/**
 * Keeps a broker running, from the server's side — without ever owning it.
 *
 * On startup the server asks the admin API whether a broker is already there.
 * If one is, it attaches: its devices have been connected to it all along, and
 * the restart was a non-event. If none is, it starts one, detached, and waits
 * for it to answer. While the server runs it keeps checking, and starts a new
 * broker if the old one dies.
 *
 * What it never does is stop one. The server shutting down, crashing, or being
 * restarted by `--watch` leaves the broker running, which is the point. A stale
 * broker — older code than the server's — is reported rather than replaced,
 * because replacing it drops every device on it; `npm run broker:restart` does that
 * when you choose to.
 */

export type BrokerStatus =
  /** A kraftverk broker answered. */
  | 'running'
  /** One is being started. */
  | 'starting'
  /** Nothing answered, and this server may not or could not start one. */
  | 'down'
  /** The MQTT port is held by something that is not a kraftverk broker. */
  | 'foreign';

export type SupervisorState = {
  status: BrokerStatus;
  health: BrokerHealth | null;
  /** Why it is not running, in words, when it is not. */
  error: string | null;
  /** Whether this server may start a broker. False when it runs as its own service. */
  spawns: boolean;
  /** Brokers this server process has had to start. */
  started: number;
  /** The code on disk. Compared with the running broker's to spot a stale one. */
  expectedBuild: string;
  /** Null until a broker has answered. */
  buildMatches: boolean | null;
  adminUrl: string;
};

export type SupervisorOptions = {
  adminUrl: string;
  /** Where to look for something on the MQTT port when the admin API is silent. */
  mqtt: { host: string; port: number };
  /** Start a broker when none is running. Off when it is its own container. */
  spawn: boolean;
  /** Passed to a broker this starts. */
  env: Record<string, string>;
  dir: string;
  log: (message: string, level?: 'info' | 'warn' | 'error') => void;
  /** How long to wait for a started broker to answer. */
  startTimeoutMs?: number;
};

const HERE = import.meta.dirname;

export class BrokerSupervisor extends EventEmitter<{ state: [SupervisorState] }> {
  #state: SupervisorState;
  #pending: Promise<SupervisorState> | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;
  /** Not before this time: a broker that fails to start is not retried in a tight loop. */
  #cooldownUntil = 0;

  constructor(private options: SupervisorOptions) {
    super();
    this.#state = {
      status: 'starting',
      health: null,
      error: null,
      spawns: options.spawn,
      started: 0,
      expectedBuild: brokerBuild(),
      buildMatches: null,
      adminUrl: options.adminUrl,
    };
  }

  get state(): SupervisorState {
    return this.#state;
  }

  /** Makes sure a broker is running, starting one if it may. Never throws. */
  ensure(): Promise<SupervisorState> {
    this.#pending ??= this.#ensure().finally(() => {
      this.#pending = null;
    });
    return this.#pending;
  }

  /** Checks on the broker every `intervalMs`, and starts a new one if it died. */
  watch(intervalMs = 5000): void {
    this.#timer ??= setInterval(() => void this.ensure(), intervalMs);
    this.#timer.unref?.();
  }

  /** Stops watching. The broker itself keeps running. */
  release(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  async #ensure(): Promise<SupervisorState> {
    // Asked twice, the second time more patiently, before concluding anything:
    // a broker busy for a moment must not be declared dead — or worse, foreign.
    const health = (await probeHealth(this.options.adminUrl)) ?? (await probeHealth(this.options.adminUrl, 4000));
    if (health) return this.#set({ status: 'running', health, error: null });

    const wasRunning = this.#state.status === 'running';
    if (wasRunning) {
      this.options.log(`The broker (pid ${this.#state.health?.pid}) stopped answering`, 'warn');
    }

    if (await portInUse(this.options.mqtt.host, this.options.mqtt.port)) {
      return this.#set({
        status: 'foreign',
        health: null,
        error:
          `Port ${this.options.mqtt.port} is held by something that is not a kraftverk broker — an older ` +
          'kraftverk server with the broker built in, or another MQTT broker. Stop it, and this server will ' +
          'start its own.',
      });
    }

    if (!this.options.spawn) {
      return this.#set({
        status: 'down',
        health: null,
        error: `No broker answers at ${this.options.adminUrl}. It runs as its own service here, so start that.`,
      });
    }

    if (Date.now() < this.#cooldownUntil) return this.#state;
    return this.#start();
  }

  async #start(): Promise<SupervisorState> {
    this.#set({ status: 'starting', health: null, error: null });
    const files = paths(this.options.dir);

    let pid: number | null = null;
    try {
      pid = await launch(join(HERE, 'launcher.ts'), join(HERE, 'main.ts'), files.stdout, {
        ...this.options.env,
        KRAFTVERK_BROKER_DIR: this.options.dir,
      });
    } catch (error) {
      return this.#failed(`the launcher failed: ${(error as Error).message}`, files.stdout);
    }

    const deadline = Date.now() + (this.options.startTimeoutMs ?? 10_000);
    while (Date.now() < deadline) {
      const health = await probeHealth(this.options.adminUrl);
      if (health) {
        this.#state.started++;
        this.options.log(
          `Started the broker (pid ${health.pid}), detached: it keeps running after whatever started it exits. ` +
            `Journal in ${files.logs}`
        );
        return this.#set({ status: 'running', health, error: null });
      }
      if (pid !== null && !alive(pid)) break;
      await sleep(200);
    }
    return this.#failed(`it did not answer within ${Math.round((this.options.startTimeoutMs ?? 10_000) / 1000)} s`, files.stdout);
  }

  #failed(why: string, stdout: string): SupervisorState {
    this.#cooldownUntil = Date.now() + 30_000;
    // Said here, with the evidence, rather than by `#set` without it.
    const tail = lastLines(stdout, 12);
    this.options.log(`Could not start the broker: ${why}. Trying again in 30 s.${tail ? `\n${tail}` : ''}`, 'error');
    return this.#set({ status: 'down', health: null, error: `The broker could not be started: ${why}. See ${stdout}` }, true);
  }

  #set(next: Partial<SupervisorState>, quiet = false): SupervisorState {
    const before = this.#state;
    this.#state = {
      ...before,
      ...next,
      // Only a broker that answered can match or not; one that is gone is unknown.
      buildMatches: 'health' in next ? (next.health ? next.health.build === before.expectedBuild : null) : before.buildMatches,
    };
    const state = this.#state;

    if (state.status !== before.status || state.health?.pid !== before.health?.pid) {
      if (state.status === 'running' && state.health && state.buildMatches === false) {
        this.options.log(
          `The running broker (pid ${state.health.pid}) is build ${state.health.build}; this code is ` +
            `${state.expectedBuild}. It keeps running, because restarting it drops every device on it — ` +
            'run `npm run broker:restart` when that is acceptable.',
          'warn'
        );
      }
      if (!quiet && state.status !== 'running' && state.error && state.status !== before.status) {
        this.options.log(state.error, state.status === 'foreign' ? 'error' : 'warn');
      }
      this.emit('state', state);
    }
    return state;
  }
}

/** The broker's `/health`, or null when nothing (or nothing kraftverk) answers. */
export async function probeHealth(adminUrl: string, timeoutMs = 1500): Promise<BrokerHealth | null> {
  try {
    const response = await fetch(`${adminUrl}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return null;
    const body = (await response.json()) as Partial<BrokerHealth>;
    return body.name === 'kraftverk-broker' ? (body as BrokerHealth) : null;
  } catch {
    return null;
  }
}

/** Whether something accepts TCP connections on the port. */
export function portInUse(host: string, port: number, timeoutMs = 700): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: host === '0.0.0.0' ? '127.0.0.1' : host, port });
    const done = (result: boolean) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** A launcher that has not reported back by now is not going to. */
const LAUNCH_TIMEOUT_MS = 15_000;

/**
 * Starts the broker through `launcher.ts`, and returns a pid to watch while it
 * comes up. Why there is a launcher at all — tree kills, and Windows handing
 * children handles nobody gave them — is explained there.
 *
 * Bounded: whatever goes wrong inside the launcher, the server's startup waits
 * at most `LAUNCH_TIMEOUT_MS` for it and then says so. An earlier version went
 * through PowerShell with no limit, and a PowerShell hung machine-wide would
 * have held the server's startup with it for ever.
 */
function launch(launcher: string, main: string, stdout: string, env: Record<string, string>): Promise<number | null> {
  mkdirSync(dirname(stdout), { recursive: true });
  rotate(stdout);

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [launcher, main, stdout], {
      // Its own process group, so Ctrl+C in the server's terminal does not
      // reach it in the moment it exists.
      detached: true,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    let out = '';
    let err = '';
    child.stdout?.on('data', (chunk) => (out += chunk));
    child.stderr?.on('data', (chunk) => (err += chunk));

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`the launcher did not report back within ${LAUNCH_TIMEOUT_MS / 1000} s`));
    }, LAUNCH_TIMEOUT_MS);

    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    // `close`, not `exit`: the pid line may still be in the pipe when the
    // process has gone. Safe to wait for, because the broker is created with
    // nothing inherited and so does not hold the launcher's pipes open.
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(err.trim() || `exit code ${code}`));
      try {
        resolve((JSON.parse(out.trim().split('\n').at(-1) ?? '{}') as { pid?: number }).pid ?? null);
      } catch {
        resolve(null);
      }
    });
  });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Keeps the broker's console file from growing for ever. It is appended to by
 * every broker this directory has run, and nothing else prunes it; one previous
 * generation is kept, because a crash loop's first attempt is the evidence.
 */
function rotate(file: string, limit = 5 * 1024 * 1024): void {
  try {
    if (statSync(file).size > limit) renameSync(file, `${file}.1`);
  } catch {
    // Missing is the common case; failing to rotate is not a reason not to start.
  }
}

function lastLines(file: string, count: number): string {
  try {
    return readFileSync(file, 'utf8').trimEnd().split('\n').slice(-count).join('\n');
  } catch {
    return '';
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
