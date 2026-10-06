import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { ApiError, type ImportPlan } from '@kraftverk/api-contract';
import type { Configuration, ImportMode, Restored } from '@kraftverk/hub';

/*
  The configuration kept beside the database (docs/CONFIG.md), as a file on
  the server's disk: the whole of it — devices, how each is reached and its
  secrets, links, automations, the home's values — rewritten within a moment
  of any change to it, so that a database set aside for a new schema is a
  home restored, not a home added again by hand. What it says is the hub's
  (`Configuration.kept`); where it is, its earlier copies and the copy a
  restore is made from are the server's. Its secrets are kept as the
  database keeps them, sealed with the server's key when it has one; the
  file never leaves the server.
*/

/** How long after a change it is written: one write for a burst of changes. */
const SETTLE_MS = 2_000;
/** How many earlier ones are kept beside it: kraftverk.yaml.1 the latest of them. */
const KEPT = 5;
/** How many copies a restore was made from are kept: the latest, and those before it. */
const COPIES_KEPT = 5;

export class ConfigSnapshot {
  #timer: ReturnType<typeof setTimeout> | null = null;
  #writtenAt: string | null = null;
  #writing: Promise<boolean> | null = null;
  /** What restoring it did as the server started, when it did. */
  restored: Restored | null = null;

  constructor(
    private configuration: Pick<Configuration, 'kept' | 'restore' | 'plan'>,
    /** Where it is kept: `config/kraftverk.yaml` beside the database (`besideDatabase`). */
    private file: string
  ) {}

  /**
   * What the server does with it as it starts. A database started afresh
   * this run — a new schema set the old one aside — is restored from it,
   * before anything is written over it; a restore that brought nothing in,
   * or a fresh start with nothing kept, leaves the file as it is until
   * something changes. Otherwise it is written now.
   */
  async begin(fresh: boolean): Promise<void> {
    /*
      A restore not finished — it failed, or the server stopped during it —
      is tried again at the next start, however the database looks then: the
      file is never written over before what it holds is in the database.
    */
    const unfinished = existsSync(this.#restoring);
    if (fresh || unfinished) {
      if (unfinished && !fresh) console.warn('[config] The last restore from the configuration kept beside the database did not finish: trying it again');
      // Marked only when there is something to restore: a home started with nothing kept has no folder for it yet.
      if (existsSync(this.file)) writeFileSync(this.#restoring, new Date().toISOString());
      let restored: Restored | null;
      try {
        restored = await this.restore();
      } catch (error) {
        console.error(`[config] Restoring from the configuration kept beside the database failed; it is kept as it is, and tried again at the next start: ${(error as Error).stack ?? error}`);
        return;
      }
      if (restored) {
        const brought = restored.applied ? `${restored.applied.devices.added.length} devices, ${restored.applied.automations.added.length} automations` : 'nothing';
        const problems = restored.problems.length ? `; ${restored.problems.length} problems: ${restored.problems.join('; ')}` : '';
        console.log(`[config] Restored from the configuration kept beside the database: ${brought}${problems}`);
      }
      // Nothing to restore from, or done: finished. Not done: kept, and tried again at the next start.
      if (!restored || restored.applied) rmSync(this.#restoring, { force: true });
      if (!restored?.applied) return;
    }
    try {
      await this.write();
    } catch (error) {
      console.warn(`[config] The configuration could not be kept beside the database: ${(error as Error).message}`);
    }
  }

  /** Writes it again a moment from now: one write for a burst of changes. */
  schedule(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.write().catch((error) => console.warn(`[config] The configuration could not be kept beside the database: ${(error as Error).message}`));
    }, SETTLE_MS);
  }

  /** What was due is written as it stops: a change just made is not lost to a restart. */
  async stop(): Promise<void> {
    if (!this.#timer) return;
    clearTimeout(this.#timer);
    this.#timer = null;
    await this.write();
  }

  /** When it was last written, or null when not since the server started. */
  get writtenAt(): string | null {
    return this.#writtenAt;
  }

  get path(): string {
    return this.file;
  }

  /** Beside the file while a restore from it is not finished. */
  get #restoring(): string {
    return `${this.file}.restoring`;
  }

  /**
   * Writes it now, unless it already says this. The one before it is kept,
   * and the ones before that, five in all; the write itself goes through a
   * file beside it, so a crash leaves the old one whole. One write at a time.
   * Returns whether it wrote.
   */
  write(): Promise<boolean> {
    const previous = this.#writing ?? Promise.resolve(false);
    const next = previous.catch(() => false).then(() => this.#write());
    const settled = next.finally(() => {
      if (this.#writing === settled) this.#writing = null;
    });
    // Its failure is the caller's, through `next`: the queue only waits for it, and is not left a rejection nobody hears.
    settled.catch(() => {});
    this.#writing = settled;
    return next;
  }

  async #write(): Promise<boolean> {
    const before = existsSync(this.file) ? readFileSync(this.file, 'utf8') : null;
    const text = await this.configuration.kept(before);
    mkdirSync(dirname(this.file), { recursive: true });
    if (before === text) return false;
    // Written beside it first, the earlier ones moved along and the current one copied, and only then put in its
    // place in one step: a crash at any point leaves a kraftverk.yaml whole — the old one, or the new.
    const writing = `${this.file}.writing`;
    writeFileSync(writing, text, { mode: 0o600 });
    if (before !== null) {
      for (let n = KEPT - 1; n >= 1; n--) if (existsSync(`${this.file}.${n}`)) renameSync(`${this.file}.${n}`, `${this.file}.${n + 1}`);
      copyFileSync(this.file, `${this.file}.1`);
    }
    renameSync(writing, this.file);
    this.#writtenAt = new Date().toISOString();
    return true;
  }

  /**
   * Restores the home from it, when there is one: copied aside first
   * (`kraftverk.before-<time>.yaml`, the last five kept), then restored by
   * the hub from that copy. Null when there is nothing to restore from.
   */
  async restore(): Promise<Restored | null> {
    if (!existsSync(this.file)) return null;
    const stamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z').replaceAll(':', '-');
    const copy = `${this.file.replace(/\.yaml$/, '')}.before-${stamp}.yaml`;
    copyFileSync(this.file, copy);
    this.#forgetOldCopies();
    this.restored = await this.configuration.restore(readFileSync(copy, 'utf8'), copy);
    return this.restored;
  }

  /**
   * An import's plan of the copy the last restore was made from: to bring in
   * with its answers what the restore could not do alone. Its secrets are
   * this server's own, sealed with its key — opened as only the server's own
   * copy may be, never through the API.
   */
  planAgain(mode: ImportMode, by: string): Promise<ImportPlan> {
    const from = this.restored?.from;
    if (!from || !existsSync(from)) throw new ApiError('not-found', 'There is no restored copy to import again');
    return this.configuration.plan(readFileSync(from, 'utf8'), { mode, kept: true }, by);
  }

  /** The copies a restore was made from, the oldest beyond those kept deleted: every fresh start would otherwise leave one more for ever. */
  #forgetOldCopies(): void {
    const stem = `${basename(this.file).replace(/\.yaml$/, '')}.before-`;
    const copies = readdirSync(dirname(this.file))
      .filter((name) => name.startsWith(stem) && name.endsWith('.yaml'))
      .sort();
    for (const name of copies.slice(0, Math.max(0, copies.length - COPIES_KEPT))) rmSync(join(dirname(this.file), name), { force: true });
  }
}
