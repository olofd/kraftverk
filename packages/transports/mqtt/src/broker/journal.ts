import { appendFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import type { JournalEntry, JournalLevel } from './shared.ts';

/**
 * Everything the broker saw, in order.
 *
 * The broker exists to be the one thing that is always there when a device
 * calls, and its journal is how you find out what the device actually did:
 * whether it opened a socket at all, what it asked for, what it was sent, and
 * why each session ended. It is written three ways, for three readers:
 *
 * - a JSONL file per day, which survives the broker and is what to read when
 *   something went wrong overnight;
 * - two rings in memory, which the admin API serves to the server and the app;
 * - the console, at a level of your choosing, for whoever is watching.
 *
 * Two rings rather than one because the traffic is lopsided. A device polled
 * every five seconds produces an entry a second, and in a single ring an hour
 * of that would push out the one disconnect you were looking for.
 */

const RANK: Record<JournalLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export const atLeast = (level: JournalLevel, threshold: JournalLevel) => RANK[level] >= RANK[threshold];

export type JournalOptions = {
  /** Where the daily files go. Null keeps the journal in memory only — for tests. */
  dir: string | null;
  /** The quietest level printed. Everything is written to the file regardless. */
  consoleLevel?: JournalLevel | 'off';
  /** Days of files to keep. */
  retainDays?: number;
  now?: () => Date;
};

export type JournalQuery = {
  after?: number;
  limit?: number;
  level?: JournalLevel;
  /** A device's address. */
  device?: string;
  kinds?: string[];
};

type Draft = Omit<JournalEntry, 'seq' | 'at'>;

export class Journal {
  #seq = 0;
  #all: JournalEntry[] = [];
  #notable: JournalEntry[] = [];
  #allLimit = 4000;
  #notableLimit = 1500;
  #listeners = new Set<(entry: JournalEntry) => void>();
  #day: string | null = null;
  #file: string | null = null;
  #writeFailed = false;
  /** Lines not yet in their file, by file: written together, a moment later, rather than one write per message. */
  #unwritten = new Map<string, string[]>();
  #flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private options: JournalOptions) {
    if (options.dir) {
      mkdirSync(options.dir, { recursive: true });
      this.#prune();
    }
  }

  get #now(): Date {
    return this.options.now?.() ?? new Date();
  }

  /** The file today's entries are going to, if any. */
  get file(): string | null {
    return this.#file;
  }

  get lastSeq(): number {
    return this.#seq;
  }

  debug(draft: Omit<Draft, 'level'>): JournalEntry {
    return this.write({ ...draft, level: 'debug' });
  }
  info(draft: Omit<Draft, 'level'>): JournalEntry {
    return this.write({ ...draft, level: 'info' });
  }
  warn(draft: Omit<Draft, 'level'>): JournalEntry {
    return this.write({ ...draft, level: 'warn' });
  }
  error(draft: Omit<Draft, 'level'>): JournalEntry {
    return this.write({ ...draft, level: 'error' });
  }

  write(draft: Draft): JournalEntry {
    const at = this.#now;
    const entry: JournalEntry = { seq: ++this.#seq, at: at.toISOString(), ...draft };

    this.#all.push(entry);
    if (this.#all.length > this.#allLimit) this.#all.shift();
    if (atLeast(entry.level, 'info')) {
      this.#notable.push(entry);
      if (this.#notable.length > this.#notableLimit) this.#notable.shift();
    }

    this.#toFile(entry, at);
    this.#toConsole(entry);
    for (const listener of this.#listeners) {
      try {
        listener(entry);
      } catch {
        // A listener's bug must not stop the journal recording the next event.
      }
    }
    return entry;
  }

  onEntry(listener: (entry: JournalEntry) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Entries in order, oldest first — the most recent `limit` of those matching.
   *
   * Tolerant of what a query string hands it: a `limit` or `after` that is not
   * a number falls back to the default rather than becoming NaN, which
   * `slice` would read as "everything".
   */
  query({ after, limit, level = 'debug', device, kinds }: JournalQuery = {}): JournalEntry[] {
    const since = Number.isFinite(after) ? after! : 0;
    const count = Number.isFinite(limit) ? Math.max(1, Math.min(Math.floor(limit!), 2000)) : 200;
    const threshold = level in RANK ? level : 'debug';
    // The notable ring reaches further back, so use it whenever debug is not wanted.
    const source = atLeast(threshold, 'info') ? this.#notable : this.#all;
    const matches = source.filter(
      (entry) =>
        entry.seq > since &&
        atLeast(entry.level, threshold) &&
        (!device || entry.device === device) &&
        (!kinds || kinds.includes(entry.kind))
    );
    return matches.slice(-count);
  }

  #toFile(entry: JournalEntry, at: Date): void {
    if (!this.options.dir) return;

    // Local date, so a file's name matches the day its reader remembers.
    const day = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
    if (day !== this.#day) {
      this.#day = day;
      this.#file = join(this.options.dir, `broker-${day}.jsonl`);
      this.#prune();
    }

    const lines = this.#unwritten.get(this.#file!) ?? [];
    lines.push(`${JSON.stringify(entry)}\n`);
    this.#unwritten.set(this.#file!, lines);
    // A bridge's devices speak many times a second: their lines go to the file together.
    this.#flushTimer ??= setTimeout(() => this.flush(), FLUSH_AFTER_MS);
    this.#flushTimer.unref?.();
  }

  /** Writes what is waiting for the file now: on a timer, and before the broker stops. */
  flush(): void {
    if (this.#flushTimer) clearTimeout(this.#flushTimer);
    this.#flushTimer = null;
    const waiting = [...this.#unwritten];
    this.#unwritten.clear();
    for (const [file, lines] of waiting) {
      try {
        appendFileSync(file, lines.join(''));
        this.#writeFailed = false;
      } catch (error) {
        // Said once, not once per entry: a full disk would otherwise fill the console.
        if (!this.#writeFailed) console.error(`[broker] Could not write the journal: ${(error as Error).message}`);
        this.#writeFailed = true;
      }
    }
  }

  #toConsole(entry: JournalEntry): void {
    const threshold = this.options.consoleLevel ?? 'info';
    // An unknown level from the environment prints at info rather than nothing.
    if (threshold === 'off' || !atLeast(entry.level, threshold in RANK ? threshold : 'info')) return;
    const line = formatEntry(entry);
    if (entry.level === 'error') console.error(line);
    else if (entry.level === 'warn') console.warn(line);
    else console.log(line);
  }

  /** Deletes daily files older than the retention window. */
  #prune(): void {
    const dir = this.options.dir;
    if (!dir) return;
    const days = this.options.retainDays;
    const keep = days !== undefined && Number.isFinite(days) && days > 0 ? days : 14;
    const cutoff = this.#now.getTime() - keep * 86_400_000;
    try {
      for (const name of readdirSync(dir)) {
        const match = /^broker-(\d{4})-(\d{2})-(\d{2})\.jsonl$/.exec(name);
        if (!match) continue;
        const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
        if (date.getTime() < cutoff) rmSync(join(dir, name), { force: true });
      }
    } catch {
      // Pruning is housekeeping; failing at it is not a reason to stop logging.
    }
  }
}

/** How long a line waits for the ones after it before they go to the file together. */
const FLUSH_AFTER_MS = 200;

const pad = (n: number) => String(n).padStart(2, '0');

const LABEL: Record<JournalLevel, string> = { debug: 'debug', info: 'info ', warn: 'WARN ', error: 'ERROR' };

/** One line: local time, level, and the entry's own sentence. */
export function formatEntry(entry: JournalEntry): string {
  const at = new Date(entry.at);
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}.${String(at.getMilliseconds()).padStart(3, '0')}`;
  return `${time} ${LABEL[entry.level]} ${entry.message}`;
}

/** "3.2 s", "4 min 10 s", "2 h 5 min" — for sentences about how long something took. */
export function duration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ${Math.round(seconds % 60)} s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ${minutes % 60} min`;
  return `${Math.floor(hours / 24)} d ${hours % 24} h`;
}
