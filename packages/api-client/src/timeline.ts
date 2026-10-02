import type { AuditEntry, AutomationMode } from '@kraftverk/api-contract';

/*
  An automation's timeline, as its page reads it: the entries that stand for
  its runs — whose story is the run itself — apart from the changes made to
  it, and what each change changed, as data the page words. Pure, so it is
  tested without a screen.
*/

/** A timeline entry that stands for a run: the engine notes each with the run it is (`detail.run`). */
export const isRunEntry = (entry: Pick<AuditEntry, 'kind' | 'detail'>): boolean =>
  entry.kind.startsWith('automation.') && typeof entry.detail === 'object' && entry.detail !== null && 'run' in entry.detail;

/** An automation as a change records it, before and after. */
type Recorded = { mode?: AutomationMode; recheckMinutes?: number | null; rule?: unknown; roles?: unknown; starts?: unknown; homePlace?: number | null };

/** What one change to an automation changed: each setting from and to, and whether what it does, or what it uses, changed. */
export type AutomationChange = {
  mode?: { from: AutomationMode; to: AutomationMode };
  recheckMinutes?: { from: number | null; to: number | null };
  rule: boolean;
  uses: boolean;
  homePlace?: 'put' | 'taken';
};

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** What a change made to an automation changed, from what it recorded before and after; null for an entry that recorded neither. */
export function automationChangeOf(entry: Pick<AuditEntry, 'detail'>): AutomationChange | null {
  const detail = entry.detail as { before?: Recorded; after?: Recorded } | null | undefined;
  const before = detail?.before;
  const after = detail?.after;
  if (!before || !after) return null;
  return {
    ...(after.mode && before.mode !== after.mode ? { mode: { from: before.mode ?? 'watch', to: after.mode } } : {}),
    ...((before.recheckMinutes ?? null) !== (after.recheckMinutes ?? null) ? { recheckMinutes: { from: before.recheckMinutes ?? null, to: after.recheckMinutes ?? null } } : {}),
    rule: !same(before.rule ?? null, after.rule ?? null),
    uses: !same(before.roles ?? {}, after.roles ?? {}) || !same(before.starts ?? {}, after.starts ?? {}),
    ...((before.homePlace ?? null) !== (after.homePlace ?? null) ? { homePlace: after.homePlace === null || after.homePlace === undefined ? 'taken' : 'put' } : {}),
  };
}

/**
 * An entry's summary on the automation's own page: the timeline says whose
 * each entry is — "Charge window: …", `Changed "Charge window"` — which its
 * page already does.
 */
export const summaryOn = (summary: string, automation: string): string =>
  (summary.startsWith(`${automation}: `) ? summary.slice(automation.length + 2) : summary).replace(`: "${automation}"`, '').replace(` "${automation}"`, '');
