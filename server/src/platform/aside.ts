import { existsSync } from 'node:fs';

/**
 * A name for a file kept aside — a database set aside for a new schema, the
 * copy of the configuration a restore was made from — that no file has yet:
 * `<before><time><after>`, the time to the millisecond, so the names sort as
 * they were made. Should even that be taken, `-2`, `-3` … follow the time:
 * one kept aside is never written over by the next, whatever the clock says.
 * `companions`: the files the name stands for beside itself (a database's
 * `-wal` and `-shm`), each of which must be free too.
 */
export function asideName(before: string, after = '', companions: readonly string[] = [], now = new Date()): string {
  const stamp = now.toISOString().replaceAll(':', '-');
  for (let n = 1; ; n++) {
    const name = `${before}${stamp}${n > 1 ? `-${n}` : ''}${after}`;
    if (!['', ...companions].some((suffix) => existsSync(name + suffix))) return name;
  }
}
