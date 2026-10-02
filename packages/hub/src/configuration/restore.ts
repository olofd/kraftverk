import { ApiError, type ConfigRestored } from '@kraftverk/api-contract';
import type { AuditRecord } from '@kraftverk/device-sdk';

import { applyImport, planImport, type ImportDeps } from './import.ts';

/*
  A home restored (docs/CONFIG.md): when a new schema has set the database
  aside, or there was none, the configuration kept beside the old one is
  restored — devices, how each is reached and their secrets, links,
  automations as they were, acting ones acting again — before anything is
  written over it. What cannot be restored is said, and restored without: a
  secret the home's key no longer opens leaves its device to be given it
  again. Reading the file, and copying it aside first, is the place's: it is
  handed the text, and where the copy is.
*/

export type Restored = ConfigRestored;

/** Who a restore is on the timeline: no person asked for it. */
const BY = 'kraftverk';

export async function restoreFrom(deps: ImportDeps & { record: (entry: AuditRecord) => void }, text: string, from: string): Promise<Restored> {
  const at = new Date().toISOString();
  const plan = await planImport(deps, text, { mode: 'merge', kept: true, lenient: true, by: BY });
  const problems = plan.problems.map((problem) => `${problem.line ? `line ${problem.line}: ` : ''}${problem.message}`);
  if (!plan.id) {
    deps.record({ at, kind: 'config.restore-failed', actor: BY, summary: `The configuration kept beside the database could not be restored: ${problems.length} problems`, detail: { file: from, problems } });
    return { at, from, applied: null, problems };
  }
  // What it left out, what the home's key no longer opens — restored without, and said.
  problems.push(...plan.notes);
  for (const need of plan.needs.secrets) problems.push(`${need.deviceName} needs its ${need.title} again`);
  try {
    const applied = await applyImport(deps, plan.id, BY, { secrets: {}, rebind: {} }, { lenient: true });
    problems.push(...applied.notes);
    const count = applied.devices.added.length + applied.devices.restored.length + applied.devices.changed.length;
    deps.record({
      at,
      kind: 'config.restored',
      actor: BY,
      summary: `Restored ${count === 1 ? '1 device' : `${count} devices`} and ${applied.automations.added.length + applied.automations.changed.length} automations from the configuration kept beside the database`,
      detail: { file: from, applied, problems },
    });
    return { at, from, applied, problems };
  } catch (error) {
    const said = error instanceof ApiError && error.problems.length ? [...error.problems] : [(error as Error).message];
    deps.record({ at, kind: 'config.restore-failed', actor: BY, summary: 'The configuration kept beside the database could not be restored', detail: { file: from, problems: said } });
    return { at, from, applied: null, problems: [...problems, ...said] };
  }
}
