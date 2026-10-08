import type { MediaType } from '@kraftverk/api-contract';
import { hexOf, sha256 } from '@kraftverk/device-sdk';

import type { SqlDatabase } from './database.ts';

/**
 * Pictures (docs/PLAN-WORLD-MODEL.md §8.12): of homes and devices, and soon
 * of people and floors. Kept by their content — the id is the SHA-256 of the
 * bytes — so the same picture is kept once, and a name that is the content
 * can be cached for ever. Made small and stripped where they are added (the
 * app re-encodes them): what arrives here is checked for what it says it is,
 * never decoded. The bytes are kept apart from what describes them, so
 * listing pictures never reads them.
 */

export const MEDIA_TYPES = ['image/webp', 'image/jpeg', 'image/png'] as const satisfies readonly MediaType[];

/** The most a picture may be: one re-encoded at 2048 pixels a side is far less. */
export const MEDIA_MAX_BYTES = 2 * 1024 * 1024;

export type MediaRecord = { id: string; type: MediaType; bytes: number; width: number; height: number; addedAt: string };

type Row = { id: string; type: MediaType; bytes: number; width: number; height: number; added_at: string };

/** Whether the bytes are what they say they are, by their first few: no picture runs script, and none pretends. */
export function looksLike(type: MediaType, data: Uint8Array): boolean {
  const starts = (...bytes: number[]) => bytes.every((byte, index) => data[index] === byte);
  switch (type) {
    case 'image/png':
      return starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    case 'image/jpeg':
      return starts(0xff, 0xd8, 0xff);
    case 'image/webp':
      return starts(0x52, 0x49, 0x46, 0x46) && data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50;
  }
}

/** The SHA-256 of bytes, hex: a picture's id — the SDK's, which runs everywhere. */
export const mediaIdOf = (data: Uint8Array): string => hexOf(sha256(data));

export class MediaStore {
  readonly #db: SqlDatabase;

  constructor(db: SqlDatabase) {
    this.#db = db;
  }

  /** A picture kept, by the id its bytes make; one already kept is kept once. */
  put(id: string, picture: { type: MediaType; width: number; height: number; data: Uint8Array }): MediaRecord {
    this.#db.transaction(() => {
      this.#db
        .query('INSERT OR IGNORE INTO media (id, type, bytes, width, height, added_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, picture.type, picture.data.byteLength, picture.width, picture.height, new Date().toISOString());
      this.#db.query('INSERT OR IGNORE INTO media_data (media_id, data) VALUES (?, ?)').run(id, picture.data);
    })();
    return this.get(id)!;
  }

  get(id: string): MediaRecord | null {
    const row = this.#db.query<Row, [string]>('SELECT id, type, bytes, width, height, added_at FROM media WHERE id = ?').get(id);
    return row ? { id: row.id, type: row.type, bytes: row.bytes, width: row.width, height: row.height, addedAt: row.added_at } : null;
  }

  /** Its bytes, or null. */
  data(id: string): Uint8Array | null {
    const row = this.#db.query<{ data: Uint8Array }, [string]>('SELECT data FROM media_data WHERE media_id = ?').get(id);
    return row ? new Uint8Array(row.data) : null;
  }

  /** Pictures nothing shows any more, let go. Returns how many. */
  collect(): number {
    return this.#db
      .query(
        `DELETE FROM media WHERE id NOT IN (SELECT picture_id FROM home WHERE picture_id IS NOT NULL)
           AND id NOT IN (SELECT picture_id FROM device WHERE picture_id IS NOT NULL)
           AND added_at < ?`
      )
      .run(new Date(Date.now() - 24 * 3_600_000).toISOString()).changes;
  }
}
