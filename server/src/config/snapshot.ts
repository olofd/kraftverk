import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { readConfig, writeConfig } from '@kraftverk/config';
import type { AuditRecord } from '@kraftverk/device-sdk';

import { databaseFile, onAudit } from '../history/db.ts';
import { exportConfig, type ConfigDeps } from './export.ts';
import type { Restored } from './restore.ts';

/*
  The configuration kept beside the database (docs/CONFIG.md): the whole of
  it — devices, how each is reached and its secrets, links, automations, the
  home's values — rewritten within a moment of any change to it, so that a
  database set aside for a new schema is a home restored, not a home added
  again by hand. Its secrets are kept as the database keeps them, sealed with
  the server's key when it has one; the file never leaves the server.
*/

/** How long after a change it is written: one write for a burst of changes. */
const SETTLE_MS = 2_000;
/** How many earlier ones are kept beside it: kraftverk.yaml.1 the latest of them. */
const KEPT = 5;

/** The timeline's kinds that change the configuration: a run, a tool, a reading do not. */
const CHANGES = new RegExp(
  '^(' +
    [
      'device\\.(added|restored|removed|renamed|identified|picture|linked|unlinked|connection-added|connection-removed|connection-preferred|secrets-changed|saved-unchecked|keyed|exportable)',
      'automation\\.(created|changed|armed|deleted|placed)',
      'policy\\.changed',
      'config\\.(imported|restored)',
    ].join('|') +
    ')$'
);

export const snapshotFile = (): string => join(dirname(databaseFile()), 'config', 'kraftverk.yaml');

export class ConfigSnapshot {
  #timer: ReturnType<typeof setTimeout> | null = null;
  #stop: (() => void) | null = null;
  #writtenAt: string | null = null;
  /** What restoring it did as the server started, when it did. */
  restored: Restored | null = null;

  constructor(
    private deps: ConfigDeps,
    private file: string = snapshotFile()
  ) {}

  /** Follows the timeline: each change to the configuration writes it again, a moment later. */
  start(): void {
    this.#stop = onAudit((entry: AuditRecord) => {
      if (CHANGES.test(entry.kind)) this.schedule();
    });
  }

  stop(): void {
    this.#stop?.();
    this.#stop = null;
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
      // What was due is written as it stops: a change just made is not lost to a restart.
      this.write();
    }
  }

  schedule(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.write();
    }, SETTLE_MS);
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
   * file beside it, so a crash leaves the old one whole. Returns whether it
   * wrote.
   */
  write(): boolean {
    const before = existsSync(this.file) ? readFileSync(this.file, 'utf8') : null;
    const { document, context } = exportConfig(this.deps, { secrets: 'kept', keptBefore: before ? (readConfig(before).document?.secrets ?? {}) : {} });
    const text = writeConfig(document, {
      ...context,
      heading: [
        'Kept by kraftverk beside its database, and written again after every change to it.',
        'When a new schema sets the database aside, the server restores from this file.',
        'Its secrets are sealed with this server\'s key, or kept as the database keeps them: it never leaves the server.',
      ].join('\n'),
    });
    mkdirSync(dirname(this.file), { recursive: true });
    if (before === text) return false;
    if (before !== null) {
      for (let n = KEPT - 1; n >= 1; n--) if (existsSync(`${this.file}.${n}`)) renameSync(`${this.file}.${n}`, `${this.file}.${n + 1}`);
      renameSync(this.file, `${this.file}.1`);
    }
    const next = `${this.file}.writing`;
    writeFileSync(next, text, { mode: 0o600 });
    renameSync(next, this.file);
    this.#writtenAt = new Date().toISOString();
    return true;
  }
}
