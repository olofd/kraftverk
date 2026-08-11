import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import type { TransportKind } from './transport/types.ts';

/**
 * Remembers which station the user chose, so a restart reconnects to the same
 * unit instead of adopting whichever device happens to speak first.
 */

const FILE = resolve(import.meta.dirname, '../data/binding.json');

export type Binding = { kind: TransportKind; id: string; boundAt: string };

export async function loadBinding(): Promise<Binding | null> {
  try {
    const raw = JSON.parse(await readFile(FILE, 'utf8')) as Partial<Binding>;
    if (raw && (raw.kind === 'mqtt' || raw.kind === 'ble') && typeof raw.id === 'string') {
      return { kind: raw.kind, id: raw.id, boundAt: raw.boundAt ?? new Date().toISOString() };
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT') console.warn('[binding] could not read binding.json:', error);
  }
  return null;
}

export async function saveBinding(binding: Binding | null): Promise<void> {
  await mkdir(dirname(FILE), { recursive: true });
  await writeFile(FILE, `${JSON.stringify(binding, null, 2)}\n`, 'utf8');
}
