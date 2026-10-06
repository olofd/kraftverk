import { EVERY_SECONDS, HOLD_SECONDS } from '../clock.ts';
import type { Rule, RuleTrigger, Step, Trigger } from '../rule.ts';
import type { FieldSpec, KindDocs, KindIcon, Say } from './spec.ts';

/*
  What starts an automation, as data: each kind of trigger once — its fields,
  its words, its place in the editor and in the reference — and the fields
  every kind has besides: a name of its own, and steps of its own. Everything
  that handles triggers reads it from here.
*/

export type TriggerKind = 'at' | 'every' | 'event' | 'becomes';

/** A trigger of one kind. */
export type TriggerOf<K extends TriggerKind> = K extends TriggerKind ? Extract<Trigger, Record<K, unknown>> : never;

export type TriggerSpec<K extends TriggerKind = TriggerKind> = {
  /** Its key in the data and its verb in a file. */
  kind: K;
  /** What the editor calls it, its mark, and the line under it. */
  label: string;
  icon: KindIcon;
  says: string;
  /** Its fields, its verb's first. */
  fields: readonly FieldSpec[];
  /** One to start from, which its fields can draw. */
  blank: () => TriggerOf<K>;
  /** In a sentence, a person's way: "Every day at 07:00", "When the station's charge is below 15 % for 2 min". */
  words: (trigger: TriggerOf<K>, say: Say) => string;
  docs: KindDocs;
};

const AT: TriggerSpec<'at'> = {
  kind: 'at',
  label: 'At a time',
  icon: 'clock',
  says: 'A time of day, every day or on the days you choose.',
  fields: [
    { data: ['at'], key: 'at', type: { type: 'timeOfDay' }, required: true, label: 'At' },
    { data: ['days'], key: 'days', type: { type: 'days' }, required: false, label: 'On', help: 'Every day, unless you choose days.' },
  ],
  blank: () => ({ at: { value: '07:00' } }),
  words: (trigger, say) => (trigger.days && say.days(trigger.days) !== 'every day' ? `At ${say.expr(trigger.at)} ${say.days(trigger.days)}` : `Every day at ${say.expr(trigger.at)}`),
  docs: {
    summary: 'At a time of day on the automation’s own clock: every day, or only on the days it names. A server that was down at that time still runs it within the hour, once.',
    examples: ['at: "07:00"', 'at: "22:30"\ndays: weekdays', 'at: "09:00"\ndays: [mon, wed, fri]'],
  },
};

const EVERY: TriggerSpec<'every'> = {
  kind: 'every',
  label: 'Every so often',
  icon: 'repeat',
  says: 'Every so many minutes, on the clock: every 15 is on the hour, and at :15, :30 and :45.',
  fields: [
    {
      data: ['every'],
      key: 'every',
      type: { type: 'duration', min: EVERY_SECONDS.min, max: EVERY_SECONDS.max, step: EVERY_SECONDS.step },
      required: true,
      label: 'Every',
      help: 'From 5 minutes to 12 hours, in whole minutes. Add a condition below to narrow it — between 22:00 and 06:00, say.',
    },
  ],
  blank: () => ({ every: { value: 15, unit: 'min' } }),
  words: (trigger, say) => `Every ${say.duration(trigger.every)}`,
  docs: {
    summary: 'Every so many minutes, counted on the owner’s clock from midnight: every 15 min is :00, :15, :30 and :45. Once a slot; a server that was down runs once, at the latest, and does not catch up.',
    examples: ['every: 15 min', 'every: 1 h'],
  },
};

const EVENT: TriggerSpec<'event'> = {
  kind: 'event',
  label: 'When a device says so',
  icon: 'bell',
  says: 'When a device reports something happened: mains lost, a charge started.',
  fields: [
    { data: ['event', 'event'], key: 'event', type: { type: 'event', role: 'from' }, required: true, label: 'What it reports' },
    { data: ['event', 'role'], key: 'from', type: { type: 'role' }, required: true, label: 'Which part' },
  ],
  blank: () => ({ event: { role: '', event: '' } }),
  words: (trigger, say) => `When ${say.name(trigger.event.role)} reports ${say.event(trigger.event.role, trigger.event.event)}`,
  docs: {
    summary: 'When the part filling a role raises an event its description declares: a station’s mains lost, a button pressed.',
    examples: ['event: mains.lost\nfrom: station'],
  },
};

const BECOMES: TriggerSpec<'becomes'> = {
  kind: 'becomes',
  label: 'When something holds',
  icon: 'activity',
  says: 'When a condition turns true — and, if you like, has stayed true a while.',
  fields: [
    { data: ['becomes'], key: 'becomes', type: { type: 'condition' }, required: true, label: 'When' },
    {
      data: ['heldFor'],
      key: 'for',
      type: { type: 'duration', min: HOLD_SECONDS.min, max: HOLD_SECONDS.max },
      required: false,
      label: 'And it has held for',
      help: 'So a moment does not count: a dip under load, a reading that touches the level once.',
    },
  ],
  blank: () => ({ becomes: { compare: 'gt', left: { read: { role: '', means: '' } }, right: { value: 0 } } }),
  words: (trigger, say) => `When ${say.expr(trigger.becomes)}${trigger.heldFor ? ` for ${say.duration(trigger.heldFor)}` : ''}`,
  docs: {
    summary:
      'When a condition turns true — and, with `for`, has stayed true that long. Reads and comparisons only: it is looked at on every reading, and its hold survives a restart.',
    examples: ['becomes: station.charge < 15 %\nfor: 2 min', 'becomes: station.charge < 20 %\nfor: 2 min\ndo:\n  - turn on: charger'],
  },
};

/** Every kind of trigger, by its key: the table everything that handles triggers reads. */
export const TRIGGER_KINDS: { readonly [K in TriggerKind]: TriggerSpec<K> } = { at: AT, every: EVERY, event: EVENT, becomes: BECOMES };

/**
 * The fields every trigger has, whatever its kind: after its own in a file,
 * read, checked, written and drawn as theirs are.
 */
export const TRIGGER_FIELDS: readonly FieldSpec[] = [
  {
    data: ['id'],
    key: 'id',
    type: { type: 'id' },
    required: false,
    label: 'Its name',
    help: 'For steps shared by several triggers that ask which one started them: run.trigger == "low".',
  },
  {
    data: ['then'],
    key: 'do',
    type: { type: 'steps', sure: 'inherit' },
    required: false,
    label: 'Then',
    help: 'What it does when this starts it. Without, the automation’s own steps.',
  },
];

/** A trigger's fields: its kind's, its verb's first, then those every trigger has. */
export const triggerFields = (trigger: Trigger): readonly FieldSpec[] => [...triggerSpec(trigger).fields, ...TRIGGER_FIELDS];

/** What every trigger may have, for the reference: a page of its own, beside the kinds'. */
export const TRIGGER_FIELDS_DOCS: KindDocs = {
  summary:
    'Every trigger may say what it does itself, under `do`: a run it starts takes those steps in place of the automation’s own — one automation, each side where it is said. And a name, `id`, that steps shared by several triggers read back as `run.trigger`.',
  examples: ['becomes: station.charge < 20 %\nfor: 2 min\ndo:\n  - turn on: charger', 'id: low\nbecomes: station.charge < 20 %'],
};

/** The order the editor offers them in. */
export const TRIGGER_KIND_ORDER: readonly TriggerKind[] = ['at', 'every', 'becomes', 'event'];

/** Which kind a trigger is — by its key; one of no kind is an error, never taken for another. */
export function triggerKind(trigger: Trigger): TriggerKind {
  const kind = TRIGGER_KIND_ORDER.find((each) => each in trigger);
  if (!kind) throw new Error(`Not a trigger: ${Object.keys(trigger).join(', ') || 'nothing'}`);
  return kind;
}

/**
 * What a trigger is known by — its state kept, the run it starts told which
 * started it: its id, or — one with none — its place among its rule's
 * triggers, "#2". Ids never start with "#".
 */
export const triggerKey = (trigger: RuleTrigger, index: number): string => trigger.id ?? `#${index}`;

/** The trigger a key names, or null: none did, or it is no longer there. */
export const triggerOf = (rule: Pick<Rule, 'when'>, key: string | null): RuleTrigger | null =>
  key === null ? null : (rule.when.find((trigger, index) => triggerKey(trigger, index) === key) ?? null);

/**
 * What a run does: the steps of the trigger that started it — or, one with
 * none of its own, a person's play, another automation's start — the rule's.
 */
export const stepsOf = (rule: Pick<Rule, 'when' | 'then'>, key: string | null): readonly Step[] => {
  const own = triggerOf(rule, key)?.then;
  return own?.length ? own : rule.then;
};

/**
 * Every list of steps a rule holds, where it is and whether what is in it
 * may wait: the rule's own, each trigger's, and what it does if a step fails —
 * what a walk over everything it may do visits.
 */
export const stepListsOf = (rule: Pick<Rule, 'when' | 'then' | 'otherwise'>): { at: string; steps: readonly Step[]; sure: boolean }[] => [
  ...rule.when.flatMap((trigger, index) => (trigger.then ? [{ at: `when[${index}].then`, steps: trigger.then, sure: true }] : [])),
  { at: 'then', steps: rule.then, sure: true },
  { at: 'otherwise', steps: rule.otherwise ?? [], sure: false },
];

/** A trigger's description. */
export const triggerSpec = (trigger: Trigger): TriggerSpec => TRIGGER_KINDS[triggerKind(trigger)] as unknown as TriggerSpec;
