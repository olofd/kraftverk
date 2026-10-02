import { copyFileSync, existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import type { ConfigRestored } from '@kraftverk/api-contract';

import { audit } from '../platform/database.ts';
import { applyImport, ImportError, planImport, type ImportDeps } from './import.ts';

/*
  A home restored (docs/CONFIG.md): when a new schema has set the database
  aside, or there was none, the server restores the configuration it kept
  beside the old one — devices, how each is reached and their secrets,
  links, automations as they were, acting ones acting again — before it
  writes anything over it. The kept file is copied aside first, the last
  five such copies kept. What cannot be restored is said, and restored
  without: a secret the server's key no longer opens leaves its device to be
  given it again.
*/

export type Restored = ConfigRestored;

/** How many copies a restore was made from are kept: the latest, and those before it. */
const COPIES_KEPT = 5;

/** The copies a restore was made from, the oldest beyond those kept deleted: every fresh start would otherwise leave one more for ever. */
function forgetOldCopies(file: string): void {
  const stem = `${basename(file).replace(/\.yaml$/, '')}.before-`;
  const copies = readdirSync(dirname(file))
    .filter((name) => name.startsWith(stem) && name.endsWith('.yaml'))
    .sort();
  for (const name of copies.slice(0, Math.max(0, copies.length - COPIES_KEPT))) rmSync(join(dirname(file), name), { force: true });
}

export async function restoreFrom(deps: ImportDeps, file: string): Promise<Restored | null> {
  if (!existsSync(file)) return null;
  const at = new Date().toISOString();
  const kept = `${file.replace(/\.yaml$/, '')}.before-${at.replace(/\.\d+Z$/, 'Z').replaceAll(':', '-')}.yaml`;
  copyFileSync(file, kept);
  forgetOldCopies(file);
  const by = 'kraftverk';
  const plan = planImport(deps, readFileSync(file, 'utf8'), { mode: 'merge', kept: true, lenient: true, by });
  const problems = plan.problems.map((problem) => `${problem.line ? `line ${problem.line}: ` : ''}${problem.message}`);
  if (!plan.id) {
    audit({ at, kind: 'config.restore-failed', actor: by, summary: `The configuration kept beside the database could not be restored: ${problems.length} problems`, detail: { file: kept, problems } });
    return { at, from: kept, applied: null, problems };
  }
  // What it left out, what the server's key no longer opens — restored without, and said.
  problems.push(...plan.notes);
  for (const need of plan.needs.secrets) problems.push(`${need.deviceName} needs its ${need.title} again`);
  try {
    const applied = await applyImport(deps, plan.id, by, { secrets: {}, rebind: {} }, { lenient: true });
    problems.push(...applied.notes);
    const count = applied.devices.added.length + applied.devices.restored.length + applied.devices.changed.length;
    audit({
      at,
      kind: 'config.restored',
      actor: by,
      summary: `Restored ${count === 1 ? '1 device' : `${count} devices`} and ${applied.automations.added.length + applied.automations.changed.length} automations from the configuration kept beside the database`,
      detail: { file: kept, applied, problems },
    });
    return { at, from: kept, applied, problems };
  } catch (error) {
    const said = error instanceof ImportError && error.problems.length ? error.problems : [(error as Error).message];
    audit({ at, kind: 'config.restore-failed', actor: by, summary: 'The configuration kept beside the database could not be restored', detail: { file: kept, problems: said } });
    return { at, from: kept, applied: null, problems: [...problems, ...said] };
  }
}
