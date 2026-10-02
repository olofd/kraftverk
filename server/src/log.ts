import { appendFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { format } from 'node:util';

/**
 * What the server said, kept.
 *
 * The server talks to its console, and in a container the console is
 * `docker logs` — which is thrown away with the container, and a deploy
 * recreates the container. So the night something went wrong is gone by the
 * morning you look, if anything was deployed in between.
 *
 * This keeps the same lines two more ways, for two readers:
 *
 * - a file per day in `KRAFTVERK_LOG_DIR` (in Docker, on the data volume),
 *   kept for two weeks — for a shell on the server;
 * - the last lines in memory, served at `/api/diagnostics/log` — for the app.
 *
 * Nothing is added to what the console already says: it is the same text,
 * with a time and a level in front.
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';
type LogLine = { at: string; level: LogLevel; text: string };

const RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const METHODS = { debug: 'debug', log: 'info', info: 'info', warn: 'warn', error: 'error' } as const;

export class ServerLog {
  readonly dir: string | null;
  #ring: LogLine[] = [];
  #day: string | null = null;
  #writeFailed = false;

  constructor(
    dir: string | null,
    private options: { retainDays?: number; ring?: number; now?: () => Date } = {}
  ) {
    if (dir) {
      try {
        mkdirSync(dir, { recursive: true });
        this.#prune(dir);
      } catch (error) {
        process.stderr.write(`[log] Cannot keep a log in ${dir}: ${(error as Error).message}. Console only.\n`);
        dir = null;
      }
    }
    this.dir = dir;
  }

  record(level: LogLevel, raw: string): void {
    // Terminal colours are for the terminal; in a file or the app they are noise.
    // eslint-disable-next-line no-control-regex
    const text = raw.replace(/\x1b\[[0-9;]*m/g, '');
    const at = (this.options.now?.() ?? new Date()).toISOString();
    const line: LogLine = { at, level, text };
    const limit = this.options.ring ?? 2000;
    this.#ring.push(line);
    if (this.#ring.length > limit) this.#ring.splice(0, this.#ring.length - limit);

    if (!this.dir) return;
    const today = at.slice(0, 10);
    try {
      if (today !== this.#day) {
        this.#day = today;
        this.#prune(this.dir);
      }
      appendFileSync(join(this.dir, `server-${today}.log`), `${at} ${level.toUpperCase().padEnd(5)} ${text}\n`);
      this.#writeFailed = false;
    } catch (error) {
      // Said once, not per line — and not through console, which would recurse.
      if (!this.#writeFailed) process.stderr.write(`[log] Cannot write the log file: ${(error as Error).message}\n`);
      this.#writeFailed = true;
    }
  }

  /** The recent lines at `level` or above, oldest first. */
  recent(limit = 500, level: LogLevel = 'debug'): LogLine[] {
    return this.#ring.filter((line) => RANK[line.level] >= RANK[level]).slice(-Math.max(1, limit));
  }

  #prune(dir: string): void {
    const now = this.options.now?.() ?? new Date();
    const cutoff = new Date(now.getTime() - (this.options.retainDays ?? 14) * 86_400_000).toISOString().slice(0, 10);
    for (const name of readdirSync(dir)) {
      const match = /^server-(\d{4}-\d{2}-\d{2})\.log$/.exec(name);
      if (match && match[1]! < cutoff) rmSync(join(dir, name), { force: true });
    }
  }
}

let kept: ServerLog | null = null;

/**
 * Starts keeping the console. Call once, first thing — anything logged before
 * is only on the console.
 */
export function keepConsole(dir: string | null): ServerLog {
  if (kept) return kept;
  const log = new ServerLog(dir);
  kept = log;
  for (const [method, level] of Object.entries(METHODS) as [keyof typeof METHODS, LogLevel][]) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      original(...args);
      log.record(level, format(...args));
    };
  }
  return log;
}

