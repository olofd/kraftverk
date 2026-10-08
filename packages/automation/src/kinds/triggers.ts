import { EVERY_SECONDS, HOLD_SECONDS } from '../clock.ts';
import { ANYONE, AXES, OWN_HOME, type Expr, type Rule, type RuleTrigger, type Step, type Trigger } from '../rule.ts';
import type { FieldSpec, KindDocs, KindIcon, Say } from './spec.ts';

/*
  What starts an automation, as data: each kind of trigger once — its fields,
  its words, its place in the editor and in the reference — and the fields
  every kind has besides: a name of its own, and steps of its own. Everything
  that handles triggers reads it from here.
*/

export type TriggerKind = 'at' | 'every' | 'event' | 'becomes' | 'arrives' | 'leaves' | 'firstArrives' | 'lastLeaves' | 'empties' | 'occupied' | 'modeBecomes' | 'modeChanges';

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
    summary: 'At a time of day on the automation’s own clock — `07:00`, or by the sun where the home is: `sunset`, `30 min before sunset` — every day, or only on the days it names. A server that was down at that time still runs it within the hour, once.',
    examples: ['at: "07:00"', 'at: "22:30"\ndays: weekdays', 'at: "09:00"\ndays: [mon, wed, fri]', 'at: sunset', 'at: 30 min before sunset\ndays: weekdays'],
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
  words: (trigger, say) => `When ${say.expr(trigger.becomes)}${trigger.heldFor && say.seconds(trigger.heldFor) !== 0 ? ` for ${say.duration(trigger.heldFor)}` : ''}`,
  docs: {
    summary:
      'When a condition turns true — and, with `for`, has stayed true that long. Reads and comparisons only: it is looked at on every reading, and its hold survives a restart.',
    examples: ['becomes: station.charge < 15 %\nfor: 2 min', 'becomes: station.charge < 20 %\nfor: 2 min\ndo:\n  - turn on: charger'],
  },
};

// --- people and places --------------------------------------------------------------------------

/** Who, in words: a role's name, or anyone of the family. */
const whoWords = (who: string, say: Say) => (who === ANYONE ? 'someone' : say.name(who));
/** A place, in words: a role's name, or the automation's own home. */
const placeWords = (place: string, say: Say) => (place === OWN_HOME ? 'home' : say.name(place));

const HOLD = { min: HOLD_SECONDS.min, max: HOLD_SECONDS.max };

const ARRIVES: TriggerSpec<'arrives'> = {
  kind: 'arrives',
  label: 'When someone arrives',
  icon: 'log-in',
  says: 'When a person, one of several, or anyone of the family comes home — or to a zone, or into a room.',
  fields: [
    { data: ['arrives', 'who'], key: 'arrives', type: { type: 'who', anyone: ANYONE }, required: true, label: 'Who', help: 'A person, people, or someone: anyone of the family.' },
    { data: ['arrives', 'at'], key: 'at', type: { type: 'place' }, required: true, label: 'At', help: 'Home — this automation’s own — another home, a zone, a room.' },
  ],
  blank: () => ({ arrives: { who: ANYONE, at: OWN_HOME } }),
  words: (trigger, say) => `When ${whoWords(trigger.arrives.who, say)} arrives ${trigger.arrives.at === OWN_HOME ? 'home' : `at ${placeWords(trigger.arrives.at, say)}`}`,
  docs: {
    summary:
      'When someone comes to a place, as presence says — as far as each shares: a role a person fills, any of a role people fill, or `someone`, anyone of the family; at `home`, the automation’s own, or a role a home, a zone or a room fills. The run knows who as `run.who`.',
    examples: ['arrives: someone\nat: home', 'arrives: olof\nat: work', 'arrives: children\nat: school'],
  },
};

const LEAVES: TriggerSpec<'leaves'> = {
  kind: 'leaves',
  label: 'When someone leaves',
  icon: 'log-out',
  says: 'When a person, one of several, or anyone of the family leaves home — or a zone, or a room.',
  fields: [
    { data: ['leaves', 'who'], key: 'leaves', type: { type: 'who', anyone: ANYONE }, required: true, label: 'Who', help: 'A person, people, or someone: anyone of the family.' },
    { data: ['leaves', 'at'], key: 'at', type: { type: 'place' }, required: true, label: 'Leaves', help: 'Home — this automation’s own — another home, a zone, a room.' },
  ],
  blank: () => ({ leaves: { who: ANYONE, at: OWN_HOME } }),
  words: (trigger, say) => `When ${whoWords(trigger.leaves.who, say)} leaves ${placeWords(trigger.leaves.at, say)}`,
  docs: {
    summary: 'When someone leaves a place, as presence says — minutes out of its geofence, not a wobble at its edge: the same `who` and `at` as `arrives`. The run knows who as `run.who`.',
    examples: ['leaves: someone\nat: home', 'leaves: olof\nat: work'],
  },
};

const FIRST_ARRIVES: TriggerSpec<'firstArrives'> = {
  kind: 'firstArrives',
  label: 'When the first arrives',
  icon: 'user-check',
  says: 'When the first of the family — or of some of you — comes to a place none of them was at.',
  fields: [
    { data: ['firstArrives', 'at'], key: 'first arrives', type: { type: 'place' }, required: true, label: 'At' },
    { data: ['firstArrives', 'of'], key: 'of', type: { type: 'crowd' }, required: false, label: 'The first of', help: 'Some of you — the children. Everyone in the family, unless you choose.' },
  ],
  blank: () => ({ firstArrives: { at: OWN_HOME } }),
  words: (trigger, say) => `When the first ${trigger.firstArrives.of ? `of ${say.name(trigger.firstArrives.of)}` : 'of the family'} arrives ${trigger.firstArrives.at === OWN_HOME ? 'home' : `at ${placeWords(trigger.firstArrives.at, say)}`}`,
  docs: {
    summary: 'When the first of the family — or, with `of`, of a role people fill — comes to a place none of them was at, as far as each shares: the place going from nobody to somebody. Its state survives a restart.',
    examples: ['first arrives: home', 'first arrives: home\nof: children'],
  },
};

const LAST_LEAVES: TriggerSpec<'lastLeaves'> = {
  kind: 'lastLeaves',
  label: 'When the last leaves',
  icon: 'user-x',
  says: 'When the last of the family — or of some of you — leaves a place: nobody of them is there.',
  fields: [
    { data: ['lastLeaves', 'at'], key: 'last leaves', type: { type: 'place' }, required: true, label: 'Leaves' },
    { data: ['lastLeaves', 'of'], key: 'of', type: { type: 'crowd' }, required: false, label: 'The last of', help: 'Some of you — the grown-ups. Everyone in the family, unless you choose.' },
  ],
  blank: () => ({ lastLeaves: { at: OWN_HOME } }),
  words: (trigger, say) => `When the last ${trigger.lastLeaves.of ? `of ${say.name(trigger.lastLeaves.of)}` : 'of the family'} leaves ${placeWords(trigger.lastLeaves.at, say)}`,
  docs: {
    summary: 'When the last of the family — or, with `of`, of a role people fill — leaves a place, as far as each shares: the place going from somebody to nobody. "When the last one leaves, set away" is this.',
    examples: ['last leaves: home', 'last leaves: home\nof: grownUps'],
  },
};

const EMPTIES: TriggerSpec<'empties'> = {
  kind: 'empties',
  label: 'When a room empties',
  icon: 'square',
  says: 'When nobody is in a room any more — whoever was — and, if you like, has not been for a while.',
  fields: [
    { data: ['empties', 'place'], key: 'empties', type: { type: 'place' }, required: true, label: 'Which room', help: 'A room, a floor, a home: whatever its sensors say of it.' },
    { data: ['empties', 'heldFor'], key: 'for', type: { type: 'duration', ...HOLD }, required: false, label: 'And it has been empty for', help: 'So walking out for a moment does not count.' },
  ],
  blank: () => ({ empties: { place: '', heldFor: { value: 10, unit: 'min' } } }),
  words: (trigger, say) => (trigger.empties.heldFor && say.seconds(trigger.empties.heldFor) !== 0 ? `When nobody has been in ${placeWords(trigger.empties.place, say)} for ${say.duration(trigger.empties.heldFor)}` : `When nobody is in ${placeWords(trigger.empties.place, say)} any more`),
  docs: {
    summary: 'When a place has nobody in it, whoever was there — by what stands in it: motion, a presence radar, a door shut with someone inside, a count — and, with `for`, has had nobody that long.',
    examples: ['empties: bathroom\nfor: 10 min', 'empties: home'],
  },
};

const OCCUPIED: TriggerSpec<'occupied'> = {
  kind: 'occupied',
  label: 'When someone is in a room',
  icon: 'users',
  says: 'When someone comes into a room — whoever it is — and, if you like, has stayed a while.',
  fields: [
    { data: ['occupied', 'place'], key: 'is occupied', type: { type: 'place' }, required: true, label: 'Which room' },
    { data: ['occupied', 'heldFor'], key: 'for', type: { type: 'duration', ...HOLD }, required: false, label: 'And has been for', help: 'So passing through does not count.' },
  ],
  blank: () => ({ occupied: { place: '' } }),
  words: (trigger, say) => (trigger.occupied.heldFor && say.seconds(trigger.occupied.heldFor) !== 0 ? `When someone has been in ${placeWords(trigger.occupied.place, say)} for ${say.duration(trigger.occupied.heldFor)}` : `When someone is in ${placeWords(trigger.occupied.place, say)}`),
  docs: {
    summary: 'When a place has someone in it, whoever they are — by what stands in it — and, with `for`, has had that long.',
    examples: ['is occupied: hallway', 'is occupied: office\nfor: 5 min'],
  },
};

const MODE_BECOMES: TriggerSpec<'modeBecomes'> = {
  kind: 'modeBecomes',
  label: 'When the mode becomes',
  icon: 'moon',
  says: 'When a home goes into a mode: away, vacation, night — or one of your own.',
  fields: [
    { data: ['modeBecomes', 'mode'], key: 'mode becomes', type: { type: 'mode' }, required: true, label: 'Which mode' },
    { data: ['modeBecomes', 'at'], key: 'at', type: { type: 'place' }, required: false, label: 'Of which home', help: 'This automation’s own, unless you choose another.' },
  ],
  blank: () => ({ modeBecomes: { mode: 'away' } }),
  words: (trigger, say) => `When ${trigger.modeBecomes.at && trigger.modeBecomes.at !== OWN_HOME ? `${say.name(trigger.modeBecomes.at)}’s` : 'the home’s'} mode becomes ${say.mode(trigger.modeBecomes.mode)}`,
  docs: {
    summary: 'When a home goes into a mode, by its key — whoever set it: a person, another automation, a vacation beginning as planned. The automation’s own home, unless `at` names another.',
    examples: ['mode becomes: away', 'mode becomes: night', 'mode becomes: vacation\nat: cabin'],
  },
};

const MODE_CHANGES: TriggerSpec<'modeChanges'> = {
  kind: 'modeChanges',
  label: 'When the mode changes',
  icon: 'home',
  says: 'When a home’s mode changes on one axis, to whichever: whether anyone is home, or the time of day.',
  fields: [
    { data: ['modeChanges', 'axis'], key: 'mode changes', type: { type: 'choice', options: AXES.map((axis) => ({ value: axis, label: axis === 'presence' ? 'Whether anyone is home' : 'The time of day' })) }, required: true, label: 'Which' },
    { data: ['modeChanges', 'at'], key: 'at', type: { type: 'place' }, required: false, label: 'Of which home', help: 'This automation’s own, unless you choose another.' },
  ],
  blank: () => ({ modeChanges: { axis: 'day' } }),
  words: (trigger, say) => `When ${trigger.modeChanges.at && trigger.modeChanges.at !== OWN_HOME ? `${say.name(trigger.modeChanges.at)}’s` : 'the home’s'} ${trigger.modeChanges.axis === 'presence' ? 'mode of presence' : 'time of day'} changes`,
  docs: {
    summary: 'When a home’s mode on an axis — `presence` or `day` — changes, to whichever: what to do as evening comes, and again as night does, read from `home.day`.',
    examples: ['mode changes: day', 'mode changes: presence\nat: cabin'],
  },
};

/** Every kind of trigger, by its key: the table everything that handles triggers reads. */
export const TRIGGER_KINDS: { readonly [K in TriggerKind]: TriggerSpec<K> } = {
  at: AT,
  every: EVERY,
  event: EVENT,
  becomes: BECOMES,
  arrives: ARRIVES,
  leaves: LEAVES,
  firstArrives: FIRST_ARRIVES,
  lastLeaves: LAST_LEAVES,
  empties: EMPTIES,
  occupied: OCCUPIED,
  modeBecomes: MODE_BECOMES,
  modeChanges: MODE_CHANGES,
};

/** The kinds that start a run as something happens — someone arrived, a mode changed — as a device's event does. */
export const HAPPENINGS: readonly TriggerKind[] = ['event', 'arrives', 'leaves', 'modeBecomes', 'modeChanges'];

/** What each part of a group is called within a condition made from a trigger: never a role's name. */
const EACH = 'eachOfThem';

/**
 * The condition a trigger waits to turn true, and how long it must hold —
 * for one that is a condition: `becomes`, and what people and places do
 * that is so for a while (the first arrived, a room empty). Null for one
 * that happens: a time, an event, someone arriving.
 */
export function edgeOf(trigger: Trigger): { condition: Expr; heldFor?: Expr } | null {
  const anyOf = (at: string, of: string | undefined): Expr =>
    of ? { across: 'any', as: EACH, group: of, of: { presentAt: { who: EACH, place: at } } } : { compare: 'gt', left: { read: { role: at, means: 'people' } }, right: { value: 0 } };
  if ('becomes' in trigger) return { condition: trigger.becomes, ...(trigger.heldFor ? { heldFor: trigger.heldFor } : {}) };
  if ('firstArrives' in trigger) return { condition: anyOf(trigger.firstArrives.at, trigger.firstArrives.of) };
  if ('lastLeaves' in trigger) return { condition: { not: anyOf(trigger.lastLeaves.at, trigger.lastLeaves.of) } };
  if ('empties' in trigger) return { condition: { not: { read: { role: trigger.empties.place, means: 'occupied' } } }, ...(trigger.empties.heldFor ? { heldFor: trigger.empties.heldFor } : {}) };
  if ('occupied' in trigger) return { condition: { read: { role: trigger.occupied.place, means: 'occupied' } }, ...(trigger.occupied.heldFor ? { heldFor: trigger.occupied.heldFor } : {}) };
  return null;
}

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
    data: ['atMostEvery'],
    key: 'at most every',
    type: { type: 'duration', min: 60, max: 7 * 86_400, fixed: true },
    required: false,
    label: 'At most every',
    help: 'A start it would make sooner than this after its last is let go.',
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
    'Every trigger may say what it does itself, under `do`: a run it starts takes those steps in place of the automation’s own — one automation, each side where it is said. A name, `id`, that steps shared by several triggers read back as `run.trigger`. And `at most every`: a start it would make sooner than that after its last is let go — a minute to a week, a number or a setting.',
  examples: ['becomes: station.charge < 20 %\nfor: 2 min\ndo:\n  - turn on: charger', 'id: low\nbecomes: station.charge < 20 %', 'becomes: charger.power > 10 W\nat most every: 30 min'],
};

/** The order the editor offers them in. */
export const TRIGGER_KIND_ORDER: readonly TriggerKind[] = ['at', 'every', 'becomes', 'event', 'arrives', 'leaves', 'firstArrives', 'lastLeaves', 'empties', 'occupied', 'modeBecomes', 'modeChanges'];

/**
 * The kind a file's trigger is, by its verb — its first field's key. Several
 * verbs at once, as `arrives` with its `at`: the one that is not `at`.
 */
export function triggerKindOfVerbs(keys: readonly string[]): TriggerKind | null {
  const found = TRIGGER_KIND_ORDER.filter((kind) => keys.includes(TRIGGER_KINDS[kind].fields[0]!.key));
  return found.find((kind) => kind !== 'at') ?? found[0] ?? null;
}

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
