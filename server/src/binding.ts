import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import type { ServerTransportKind } from './transport/types.ts';

/**
 * The old singleton binding: one station per server, in one file.
 *
 * **Legacy, and read-only.** Where a device is reached is now a property of
 * that device — `config.transport` and `config.boundId` on its catalog record,
 * managed by the `ConnectionManager` — because a file with room for one station
 * is precisely why a second one could not be represented.
 *
 * This survives only so someone who bound a station under the old code can be
 * offered a one-time import (`devices/legacy.ts`). Nothing writes it any more.
 */

/**
 * `KRAFTVERK_BINDING_FILE` exists for the same reason `KRAFTVERK_DB` does: a
 * test or a scratch server must be able to work on its own state rather than
 * rebinding — or unbinding — the station the owner actually uses.
 */
const file = () =>
  process.env.KRAFTVERK_BINDING_FILE || resolve(import.meta.dirname, '../data/binding.json');

export type Binding = { kind: ServerTransportKind; id: string; boundAt: string };

export async function loadBinding(): Promise<Binding | null> {
  try {
    const raw = JSON.parse(await readFile(file(), 'utf8')) as Partial<Binding>;
    if (raw && (raw.kind === 'mqtt' || raw.kind === 'ble') && typeof raw.id === 'string') {
      return { kind: raw.kind, id: raw.id, boundAt: raw.boundAt ?? new Date().toISOString() };
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT') console.warn('[binding] could not read binding.json:', error);
  }
  return null;
}

/** Kept for the legacy-import tests to write a fixture. Not used at runtime. */
export async function saveBinding(binding: Binding | null): Promise<void> {
  const path = file();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(binding, null, 2)}\n`, 'utf8');
}
