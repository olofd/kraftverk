import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import type { Configuration, Restored } from '@kraftverk/hub';

import { databaseFile } from './database.ts';

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

export const snapshotFile = (): string => join(dirname(databaseFile()), 'config', 'kraftverk.yaml');

export class ConfigSnapshot {
  #timer: ReturnType<typeof setTimeout> | null = null;
  #writtenAt: string | null = null;
  #writing: Promise<boolean> | null = null;
  /** What restoring it did as the server started, when it did. */
  restored: Restored | null = null;

  constructor(
    private configuration: Pick<Configuration, 'kept' | 'restore'>,
    private file: string = snapshotFile()
  ) {}

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

  /**
   * Writes it now, unless it already says this. The one before it is kept,
   * and the ones before that, five in all; the write itself goes through a
   * file beside it, so a crash leaves the old one whole. One write at a time.
   * Returns whether it wrote.
   */
  write(): Promise<boolean> {
    const previous = this.#writing ?? Promise.resolve(false);
    const next = previous.catch(() => false).then(() => this.#write());
    this.#writing = next.finally(() => {
      if (this.#writing === next) this.#writing = null;
    });
    return next;
  }

  async #write(): Promise<boolean> {
    const before = existsSync(this.file) ? readFileSync(this.file, 'utf8') : null;
    const text = await this.configuration.kept(before);
    mkdirSync(dirname(this.file), { recursive: true });
    if (before === text) return false;
    if (before !== null) {
      for (let n = KEPT - 1; n >= 1; n--) if (existsSync(`${this.file}.${n}`)) renameSync(`${this.file}.${n}`, `${this.file}.${n + 1}`);
      renameSync(this.file, `${this.file}.1`);
    }
    const writing = `${this.file}.writing`;
    writeFileSync(writing, text, { mode: 0o600 });
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

  /** The copy the last restore was made from, to import again: its text, or null when there is none. */
  restoredCopy(): string | null {
    const from = this.restored?.from;
    return from && existsSync(from) ? readFileSync(from, 'utf8') : null;
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
