import type { CapabilityName } from '@kraftverk/device-sdk';

import { SEQUENCE_LIMITS, type Command, type Expr, type Step, type Write } from '../rule.ts';
import type { FieldSpec, KindDocs, KindIcon } from './spec.ts';

/*
  What an automation does, as data: each kind of step once — its fields, its
  words, its place in the editor and in the reference, how a file writes it.
  Everything that handles steps reads it from here. Lengths of time are in
  seconds.
*/

export type StepKind = 'command' | 'write' | 'wait' | 'waitUntil' | 'waitFor' | 'ensure' | 'choose' | 'watch' | 'repeat' | 'forEach' | 'try' | 'stop' | 'start' | 'remember';

/** A step of one kind. */
export type StepOf<K extends StepKind> = K extends StepKind ? Extract<Step, Record<K, unknown>> : never;

/** How a sentence says a step's parts: what the describer hands a kind's words. */
export type StepSay = {
  /** An expression, its settings filled in. */
  expr(expr: Expr): string;
  /** A length of time, as its settings make it: "20 s", "2 min". */
  seconds(expr: Expr): string;
  /** How many times: "once", "twice", "5 times". */
  count(expr: Expr): string;
  /** What fills a role. */
  name(role: string): string;
  /** A command, as a person says it: "turn Charger plug on". */
  command(command: Command): string;
  /** A setting changed: "set Scooter plug's Live readings to on". */
  write(write: Write): string;
  /** Steps within, each briefly. */
  briefs(steps: readonly Step[] | undefined): string[];
  /** What it remembers, by what it is called: "Times charged". */
  memory(name: string): string;
  /** An event a role's part raises, in its own words: "mains lost". */
  event(role: string, event: string): string;
};

/** What a kind's own text form reads with: the file reader's tools. */
export type StepReader = {
  expr(data: unknown, path: readonly (string | number)[]): Expr;
  seconds(data: unknown, path: readonly (string | number)[]): Expr;
  name(data: unknown, path: readonly (string | number)[], what: string): string;
  fail(message: string, path: readonly (string | number)[]): never;
};

/** What a kind's own text form writes with. */
export type StepWriter = { expr(expr: Expr): unknown };

/**
 * A kind whose file says it in words of its own — a command as `turn on`,
 * `switch` or `send`; a setting as `set` by key or meaning — rather than its
 * fields' keys under one verb.
 */
export type StepText<K extends StepKind> = {
  /** The verbs that start it in a file. */
  verbs: readonly string[];
  read(data: Record<string, unknown>, path: readonly (string | number)[], reader: StepReader): StepOf<K>;
  write(step: StepOf<K>, writer: StepWriter): Record<string, unknown>;
  /** Its forms in the JSON Schema, one object each. */
  schema(): Record<string, unknown>[];
};

export type StepSpec<K extends StepKind = StepKind> = {
  /** Its key in the data. */
  kind: K;
  /** What the editor calls it, its mark, and the line under it. */
  label: string;
  icon: KindIcon;
  says: string;
  /** Its fields; under one verb, the first's key is it. */
  fields: readonly FieldSpec[];
  /** Taken at once — a command or a setting — so a rule of only these can be planned, and kept so. */
  atOnce?: boolean;
  /** Waits for what might not come: not in a retry, nor after a failure, where it would fail again. */
  waits?: boolean;
  /** Words of its own in a file, where its fields' keys are not enough. */
  text?: StepText<K>;
  /** One to start from, about `role` where it needs one. */
  blank: (role: string | null) => StepOf<K>;
  /** As a line of a sequence: "Wait until the plug can be reached — at most 2 min". Its branches are its steps fields'. */
  line: (step: StepOf<K>, say: StepSay) => string;
  /** In a sentence, briefly: what it does, not its branches. */
  brief: (step: StepOf<K>, say: StepSay) => string;
  docs: KindDocs;
};

/** A condition to start from: whether the part the step is about can be reached — or, with none yet, a reading still to choose. */
const someCondition = (role: string | null): Expr => (role ? { reachable: role } : { compare: 'gt', left: { read: { role: '', means: '' } }, right: { value: 0 } });

const WAIT_MAX = SEQUENCE_LIMITS.waitSeconds;

// --- at once: a command, a setting -------------------------------------------------------------

/** `switch.set` with `on` a fixed true or false: "turn on" / "turn off". */
const onOff = (command: Command): boolean | null => {
  if (command.capability !== 'switch' || command.command !== 'set') return null;
  const names = Object.keys(command.args);
  const on = command.args.on;
  return names.length === 1 && on && 'value' in on && typeof on.value === 'boolean' ? on.value : null;
};

const COMMAND: StepSpec<'command'> = {
  kind: 'command',
  label: 'Switch or send',
  icon: 'power',
  says: 'A command to a part: on, off, or what else it takes.',
  atOnce: true,
  fields: [
    { data: ['command', 'role'], key: 'to', type: { type: 'role' }, required: true, label: 'Which part' },
    { data: ['command', 'capability'], key: 'capability', type: { type: 'name' }, required: true, label: 'What it is' },
    { data: ['command', 'command'], key: 'send', type: { type: 'name' }, required: true, label: 'Which command' },
    { data: ['command', 'args'], key: 'with', type: { type: 'args' }, required: true, label: 'With' },
  ],
  text: {
    verbs: ['turn on', 'turn off', 'switch', 'send'],
    read(data, path, reader) {
      const only = (...keys: string[]) => {
        for (const key of Object.keys(data)) if (!keys.includes(key)) reader.fail(`"${key}" is not part of this step: it takes ${keys.map((each) => `"${each}"`).join(', ')}`, [...path, key]);
      };
      if ('turn on' in data || 'turn off' in data) {
        const verb = 'turn on' in data ? 'turn on' : 'turn off';
        only(verb);
        return { command: { role: reader.name(data[verb], [...path, verb], 'the role it turns'), capability: 'switch', command: 'set', args: { on: { value: verb === 'turn on' } } } };
      }
      if ('switch' in data) {
        only('switch', 'on');
        if (!('on' in data)) reader.fail('"switch" needs "on": when it is on', path);
        return { command: { role: reader.name(data.switch, [...path, 'switch'], 'the role it switches'), capability: 'switch', command: 'set', args: { on: reader.expr(data.on, [...path, 'on']) } } };
      }
      only('send', 'to', 'capability', 'with');
      const given = data.with ?? {};
      const args = typeof given === 'object' && given !== null && !Array.isArray(given) ? (given as Record<string, unknown>) : reader.fail('"with" is a map of arguments', [...path, 'with']);
      return {
        command: {
          role: reader.name(data.to, [...path, 'to'], 'the role it is sent to ("to")'),
          capability: reader.name(data.capability, [...path, 'capability'], 'the capability ("capability")') as CapabilityName,
          command: reader.name(data.send, [...path, 'send'], 'the command'),
          args: Object.fromEntries(Object.entries(args).map(([name, value]) => [name, reader.expr(value, [...path, 'with', name])])),
        },
      };
    },
    write(step, writer) {
      const { role, capability, command, args } = step.command;
      const on = onOff(step.command);
      if (on !== null) return on ? { 'turn on': role } : { 'turn off': role };
      if (capability === 'switch' && command === 'set' && Object.keys(args).length === 1 && args.on) return { switch: role, on: writer.expr(args.on) };
      const names = Object.keys(args);
      return { send: command, to: role, capability, ...(names.length ? { with: Object.fromEntries(Object.entries(args).map(([name, value]) => [name, writer.expr(value)])) } : {}) };
    },
    schema: () => [
      { title: 'Turn on', type: 'object', required: ['turn on'], additionalProperties: false, properties: { 'turn on': { type: 'string', description: 'The role it turns on' } } },
      { title: 'Turn off', type: 'object', required: ['turn off'], additionalProperties: false, properties: { 'turn off': { type: 'string', description: 'The role it turns off' } } },
      { title: 'Switch', type: 'object', required: ['switch', 'on'], additionalProperties: false, properties: { switch: { type: 'string' }, on: { $ref: '#/$defs/expression', description: 'On while this holds, off when it does not' } } },
      {
        title: 'Send a command',
        type: 'object',
        required: ['send', 'to', 'capability'],
        additionalProperties: false,
        properties: { send: { type: 'string' }, to: { type: 'string' }, capability: { type: 'string' }, with: { type: 'object', additionalProperties: { $ref: '#/$defs/expression' } } },
      },
    ],
  },
  blank: (role) => ({ command: { role: role ?? '', capability: 'switch', command: 'set', args: { on: { value: true } } } }),
  line: (step, say) => say.command(step.command),
  brief: (step, say) => say.command(step.command),
  docs: {
    summary: 'A command to the part filling a role, through the gateway, as any command is — checked, confirmed where it must be, and verified against what the device reports.',
    examples: ['turn on: charger', 'switch: charger\non: station.charge < 30 %', 'send: set\nto: charger\ncapability: switch\nwith:\n  on: true'],
  },
};

const WRITE: StepSpec<'write'> = {
  kind: 'write',
  label: 'Change a setting',
  icon: 'sliders',
  says: 'A setting the part keeps: its live readings, its light, what it does after a power cut.',
  atOnce: true,
  fields: [
    { data: ['write', 'role'], key: 'set', type: { type: 'role' }, required: true, label: 'Which part' },
    { data: ['write', 'key'], key: 'setting', type: { type: 'name' }, required: false, label: 'Which setting' },
    { data: ['write', 'means'], key: 'meaning', type: { type: 'name' }, required: false, label: 'Which setting, by what it means' },
    { data: ['write', 'value'], key: 'to', type: { type: 'value' }, required: true, label: 'To' },
  ],
  text: {
    verbs: ['set'],
    read(data, path, reader) {
      for (const key of Object.keys(data)) if (!['set', 'setting', 'meaning', 'to'].includes(key)) reader.fail(`"${key}" is not part of this step: it takes "set", "setting", "meaning", "to"`, [...path, key]);
      const role = reader.name(data.set, [...path, 'set'], 'the role whose setting it changes');
      if (!('to' in data)) reader.fail('"set" needs "to": what it is set to', path);
      if ('setting' in data === 'meaning' in data) reader.fail('"set" names its setting by key ("setting") or by what it means ("meaning"), one of them', path);
      if ('setting' in data) return { write: { role, key: reader.name(data.setting, [...path, 'setting'], 'the setting\'s key'), value: reader.expr(data.to, [...path, 'to']) } };
      const means = reader.name(data.meaning, [...path, 'meaning'], 'what the setting means');
      // By its meaning, its unit is known: what it is set to is in it.
      return { write: { role, means, value: reader.expr(data.to, [...path, 'to']) } };
    },
    write: (step, writer) =>
      step.write.key !== undefined ? { set: step.write.role, setting: step.write.key, to: writer.expr(step.write.value) } : { set: step.write.role, meaning: step.write.means, to: writer.expr(step.write.value) },
    schema: () => [
      { title: 'Change a setting, by its key', type: 'object', required: ['set', 'setting', 'to'], additionalProperties: false, properties: { set: { type: 'string' }, setting: { type: 'string' }, to: { $ref: '#/$defs/expression' } } },
      { title: 'Change a setting, by what it means', type: 'object', required: ['set', 'meaning', 'to'], additionalProperties: false, properties: { set: { type: 'string' }, meaning: { type: 'string' }, to: { $ref: '#/$defs/expression' } } },
    ],
  },
  blank: (role) => ({ write: { role: role ?? '', key: '', value: { value: true } } }),
  line: (step, say) => say.write(step.write),
  brief: (step, say) => say.write(step.write),
  docs: {
    summary: 'Change a setting the part filling a role offers, through the gateway, read back as any setting is — by its key, or by a standard meaning a recipe can name without knowing the product. Never one its device declares dangerous.',
    examples: ['set: plug\nsetting: liveReadings\nto: true', 'set: station\nmeaning: chargeLimit\nto: 80 %'],
  },
};

// --- time: pauses and waits --------------------------------------------------------------------

const WAIT: StepSpec<'wait'> = {
  kind: 'wait',
  label: 'Pause',
  icon: 'pause',
  says: 'Wait a while before the next step.',
  fields: [{ data: ['wait', 'for'], key: 'wait', type: { type: 'duration', min: 1, max: WAIT_MAX, fixed: true }, required: true, label: 'For', help: 'At most an hour.' }],
  blank: () => ({ wait: { for: { value: 10, unit: 's' } } }),
  line: (step, say) => `Wait ${say.seconds(step.wait.for)}`,
  brief: (step, say) => `wait ${say.seconds(step.wait.for)}`,
  docs: { summary: 'A pause, before the next step: at most an hour.', examples: ['wait: 5 s', 'wait: 2 min'] },
};

const WAIT_UNTIL: StepSpec<'waitUntil'> = {
  kind: 'waitUntil',
  label: 'Wait until',
  icon: 'clock',
  says: 'Wait for something to be so — at most so long, or the run does not succeed.',
  waits: true,
  fields: [
    { data: ['waitUntil', 'condition'], key: 'wait until', type: { type: 'condition', calls: false }, required: true, label: 'Until' },
    { data: ['waitUntil', 'atMost'], key: 'at most', type: { type: 'duration', min: 1, max: WAIT_MAX, fixed: true }, required: true, label: 'At most', help: 'Every wait has its limit: then the run stops, not having succeeded.' },
  ],
  blank: (role) => ({ waitUntil: { condition: someCondition(role), atMost: { value: 2, unit: 'min' } } }),
  line: (step, say) => `Wait until ${say.expr(step.waitUntil.condition)} — at most ${say.seconds(step.waitUntil.atMost)}`,
  brief: (step, say) => `wait until ${say.expr(step.waitUntil.condition)}`,
  docs: {
    summary: 'Wait until a condition is true — judged on readings taken since the run last changed something — or stop, not having succeeded, once it has waited that long.',
    examples: ['wait until: charger reachable\nat most: 2 min'],
  },
};

const WAIT_FOR: StepSpec<'waitFor'> = {
  kind: 'waitFor',
  label: 'Wait for an event',
  icon: 'bell',
  says: 'Wait until a device says something happened — at most so long, or the run does not succeed.',
  waits: true,
  fields: [
    { data: ['waitFor', 'event'], key: 'wait for', type: { type: 'event', role: 'from' }, required: true, label: 'What it says' },
    { data: ['waitFor', 'role'], key: 'from', type: { type: 'role' }, required: true, label: 'Which part' },
    { data: ['waitFor', 'atMost'], key: 'at most', type: { type: 'duration', min: 1, max: WAIT_MAX, fixed: true }, required: true, label: 'At most', help: 'Every wait has its limit: then the run stops, not having succeeded.' },
  ],
  blank: (role) => ({ waitFor: { role: role ?? '', event: '', atMost: { value: 5, unit: 'min' } } }),
  line: (step, say) => `Wait until ${say.name(step.waitFor.role)} says ${say.event(step.waitFor.role, step.waitFor.event)} — at most ${say.seconds(step.waitFor.atMost)}`,
  brief: (step, say) => `wait until ${say.name(step.waitFor.role)} says ${say.event(step.waitFor.role, step.waitFor.event)}`,
  docs: {
    summary: 'Wait until the part filling a role raises an event its description declares — one raised after the step began — or stop, not having succeeded, once it has waited that long.',
    examples: ['wait for: mains.restored\nfrom: station\nat most: 30 min'],
  },
};

const ENSURE: StepSpec<'ensure'> = {
  kind: 'ensure',
  label: 'Make sure',
  icon: 'repeat',
  says: 'Something must come true in time; if not, take steps and look again, a few times at most.',
  waits: true,
  fields: [
    { data: ['ensure', 'condition'], key: 'make sure', type: { type: 'condition', calls: false }, required: true, label: 'Make sure' },
    { data: ['ensure', 'within'], key: 'within', type: { type: 'duration', min: 1, max: SEQUENCE_LIMITS.trySeconds, fixed: true }, required: true, label: 'Within', help: 'How long each try is given: at most ten minutes.' },
    { data: ['ensure', 'tries'], key: 'tries', type: { type: 'count', max: SEQUENCE_LIMITS.tries }, required: true, label: 'Tries at most', help: 'How often it is tried again before it gives up.' },
    { data: ['ensure', 'retry'], key: 'each time', type: { type: 'steps', sure: false, nonEmpty: 'how is it tried again?' }, required: true, label: 'Each time' },
  ],
  blank: (role) => ({ ensure: { condition: someCondition(role), within: { value: 20, unit: 's' }, tries: { value: 3 }, retry: [] } }),
  line: (step, say) => `Make sure ${say.expr(step.ensure.condition)} within ${say.seconds(step.ensure.within)} — if not, try again, at most ${say.count(step.ensure.tries)}`,
  brief: (step, say) => `make sure ${say.expr(step.ensure.condition)}`,
  docs: {
    summary: 'Make sure a condition comes true within a time; if not, take the steps under `each time` and look again, at most `tries` times — then the run stops, not having succeeded.',
    examples: ['make sure: charger.power > 50 W\nwithin: 20 s\ntries: 5\neach time:\n  - turn off: charger\n  - wait: 5 s\n  - turn on: charger'],
  },
};

// --- one way or another --------------------------------------------------------------------------

const CHOOSE: StepSpec<'choose'> = {
  kind: 'choose',
  label: 'If',
  icon: 'git-branch',
  says: 'One way or the other, as something is now.',
  fields: [
    { data: ['choose', 'if'], key: 'if', type: { type: 'condition', calls: true }, required: true, label: 'If' },
    { data: ['choose', 'then'], key: 'then', type: { type: 'steps', sure: 'inherit' }, required: true, label: 'Then' },
    { data: ['choose', 'else'], key: 'else', type: { type: 'steps', sure: 'inherit' }, required: false, label: 'Otherwise' },
  ],
  blank: (role) => ({ choose: { if: someCondition(role), then: [], else: [] } }),
  line: (step, say) => `If ${say.expr(step.choose.if)}`,
  brief: (step, say) => {
    const otherwise = say.briefs(step.choose.else);
    return `if ${say.expr(step.choose.if)}, ${say.briefs(step.choose.then).join(' and ') || 'nothing'}${otherwise.length ? `, otherwise ${otherwise.join(' and ')}` : ''}`;
  },
  docs: { summary: 'One way or the other, as a condition is now. Unknown is not true: `else`.', examples: ['if: station.charge < 20 %\nthen:\n  - turn on: charger\nelse:\n  - turn off: charger'] },
};

const WATCH: StepSpec<'watch'> = {
  kind: 'watch',
  label: 'Watch',
  icon: 'eye',
  says: 'Watch something for a while: steps if it stays so, others the moment it does not.',
  fields: [
    { data: ['watch', 'condition'], key: 'watch', type: { type: 'condition', calls: false }, required: true, label: 'Watch whether' },
    { data: ['watch', 'for'], key: 'for', type: { type: 'duration', min: 1, max: WAIT_MAX, fixed: true }, required: true, label: 'For' },
    { data: ['watch', 'then'], key: 'if it stays so', type: { type: 'steps', sure: 'inherit' }, required: false, label: 'If it stays so' },
    { data: ['watch', 'else'], key: 'if not', type: { type: 'steps', sure: 'inherit' }, required: false, label: 'If not' },
  ],
  blank: (role) => ({ watch: { condition: someCondition(role), for: { value: 5, unit: 's' }, then: [] } }),
  line: (step, say) => `Watch for ${say.seconds(step.watch.for)} whether ${say.expr(step.watch.condition)}`,
  brief: (step, say) => {
    const then = say.briefs(step.watch.then);
    return `watch whether ${say.expr(step.watch.condition)}${then.length ? `, and if it stays so ${then.join(' and ')}` : ''}`;
  },
  docs: {
    summary: 'Watch a condition for a while: the steps under `if it stays so` if it stays true all that time, those under `if not` the moment it is not — or cannot be told.',
    examples: ['watch: supply.power < 10 W\nfor: 5 s\nif it stays so:\n  - turn off: supply'],
  },
};

// --- again, and again --------------------------------------------------------------------------------

const REPEAT: StepSpec<'repeat'> = {
  kind: 'repeat',
  label: 'Repeat',
  icon: 'rotate-cw',
  says: 'Take steps again and again: so many times, or until something is so.',
  fields: [
    { data: ['repeat', 'times'], key: 'repeat', type: { type: 'count', max: SEQUENCE_LIMITS.rounds }, required: true, label: 'Times, at most', help: `At most ${SEQUENCE_LIMITS.rounds}.` },
    { data: ['repeat', 'until'], key: 'until', type: { type: 'condition', calls: true }, required: false, label: 'Until', help: 'Looked at after each round: still not so after the last, it does not succeed.' },
    { data: ['repeat', 'steps'], key: 'do', type: { type: 'steps', sure: 'inherit', nonEmpty: 'what does it repeat?' }, required: true, label: 'Each round' },
  ],
  blank: () => ({ repeat: { times: { value: 3 }, steps: [] } }),
  line: (step, say) => (step.repeat.until ? `Repeat until ${say.expr(step.repeat.until)} — at most ${say.count(step.repeat.times)}` : `Repeat ${say.count(step.repeat.times)}`),
  brief: (step, say) => {
    const steps = say.briefs(step.repeat.steps).join(' and ') || 'nothing';
    return step.repeat.until ? `${steps}, until ${say.expr(step.repeat.until)}` : `${steps}, ${say.count(step.repeat.times)}`;
  },
  docs: {
    summary: 'Take the steps under `do` again and again: `repeat` times — or, with `until`, until it is so after a round, at most that many; still not so after the last, the run stops, not having succeeded.',
    examples: ['repeat: 3\ndo:\n  - turn on: charger\n  - wait: 10 s\n  - turn off: charger', 'repeat: 5\nuntil: charger.power > 50 W\ndo:\n  - turn on: charger\n  - wait: 20 s'],
  },
};

const FOR_EACH: StepSpec<'forEach'> = {
  kind: 'forEach',
  label: 'For each',
  icon: 'layers',
  says: 'Take steps for each of several parts: one after the other, or all at the same time.',
  fields: [
    { data: ['forEach', 'as'], key: 'for each', type: { type: 'each' }, required: true, label: 'Each called', help: 'What its steps call each part, in turn.' },
    { data: ['forEach', 'in'], key: 'in', type: { type: 'group' }, required: true, label: 'Of these parts' },
    { data: ['forEach', 'together'], key: 'together', type: { type: 'flag' }, required: false, label: 'All at the same time', help: 'Otherwise one after the other.' },
    { data: ['forEach', 'steps'], key: 'do', type: { type: 'steps', sure: 'inherit', nonEmpty: 'what does it do with each?' }, required: true, label: 'For each' },
  ],
  blank: () => ({ forEach: { as: 'part', in: '', steps: [] } }),
  line: (step, say) => `For each of ${say.name(step.forEach.in)}, ${step.forEach.together ? 'all at the same time' : 'one after the other'}`,
  brief: (step, say) => `${say.briefs(step.forEach.steps).join(' and ') || 'nothing'}, for each of ${say.name(step.forEach.in)}${step.forEach.together ? ' at the same time' : ''}`,
  docs: {
    summary: 'Take the steps under `do` for each part filling a group role — one after the other, or, with `together: true`, all at the same time — each called by the name after `for each` within them, as a role is. One that does not succeed: the others, together, go on to their end; one after the other, the rest are not taken.',
    examples: ['for each: outlet\nin: outlets\ndo:\n  - turn on: outlet', 'for each: outlet\nin: outlets\ntogether: true\ndo:\n  - turn on: outlet\n  - wait until: outlet.power > 10 W\n    at most: 1 min'],
  },
};

// --- when a step does not succeed ------------------------------------------------------------------

const TRY: StepSpec<'try'> = {
  kind: 'try',
  label: 'Try',
  icon: 'shield',
  says: 'Try some steps: if one does not succeed, take others — and go on.',
  fields: [
    { data: ['try', 'steps'], key: 'try', type: { type: 'steps', sure: 'inherit', nonEmpty: 'what does it try?' }, required: true, label: 'Try' },
    { data: ['try', 'recover'], key: 'if it fails', type: { type: 'steps', sure: false }, required: false, label: 'If it fails' },
  ],
  blank: () => ({ try: { steps: [] } }),
  line: (step) => (step.try.recover?.length ? 'Try — and if a step does not succeed, take others' : 'Try — and go on, whatever comes of it'),
  brief: (step, say) => {
    const recover = say.briefs(step.try.recover);
    return `try to ${say.briefs(step.try.steps).join(' and ') || 'do nothing'}${recover.length ? `, and if that does not succeed ${recover.join(' and ')}` : ''}`;
  },
  docs: {
    summary: 'Try the steps under `try`: one that does not succeed ends them, and the steps under `if it fails` are taken — none, and it goes on as if it had succeeded. The run goes on after it either way, unless what it took after a failure did not succeed. A stop is not caught.',
    examples: ['try:\n  - turn on: charger\nif it fails:\n  - turn off: supply', 'try:\n  - wait until: charger reachable\n    at most: 1 min'],
  },
};

const STOP: StepSpec<'stop'> = {
  kind: 'stop',
  label: 'Stop here',
  icon: 'octagon',
  says: 'End the run here, saying why — as it went, or as not having succeeded.',
  fields: [
    { data: ['stop', 'why'], key: 'stop', type: { type: 'text' }, required: true, label: 'Why', help: 'What the run says as it ends.' },
    { data: ['stop', 'failed'], key: 'failed', type: { type: 'flag' }, required: false, label: 'As not having succeeded', help: 'Its "if a step fails" steps are taken.' },
  ],
  blank: () => ({ stop: { why: 'Nothing more to do' } }),
  line: (step) => `${step.stop.failed ? 'Stop, not having succeeded' : 'Stop here'}: ${step.stop.why}`,
  brief: (step) => `${step.stop.failed ? 'stop, not having succeeded' : 'stop'}: ${step.stop.why}`,
  docs: {
    summary: 'End the run here, saying why: as it went — or, with `failed: true`, as not having succeeded, its `if a step fails` steps taken. Within `try`, a failure is the `if it fails` steps’ to answer.',
    examples: ['stop: Already charged', 'stop: The charger did not answer\nfailed: true'],
  },
};

// --- another automation ---------------------------------------------------------------------------

const START: StepSpec<'start'> = {
  kind: 'start',
  label: 'Start another automation',
  icon: 'play-circle',
  says: 'Start one of your automations — and wait for it to end, if you like.',
  fields: [
    { data: ['start', 'role'], key: 'start', type: { type: 'automation' }, required: true, label: 'Which automation' },
    { data: ['start', 'andWait'], key: 'and wait', type: { type: 'duration', min: 1, max: WAIT_MAX, fixed: true }, required: false, label: 'And wait until it ends, at most', help: 'Done if it acted; not if it did not, or not in time.' },
  ],
  blank: (role) => ({ start: { role: role ?? '' } }),
  line: (step, say) => `Start ${say.name(step.start.role)}${step.start.andWait ? ` and wait until it ends — at most ${say.seconds(step.start.andWait)}` : ''}`,
  brief: (step, say) => `start ${say.name(step.start.role)}${step.start.andWait ? ` and wait until it ends — at most ${say.seconds(step.start.andWait)}` : ''}`,
  docs: {
    summary: 'Start the automation filling a role, as a person’s play would — and, with `and wait`, wait until its run ends: done if it acted, not if it did not, or not within that time.',
    examples: ['start: chargeTheScooter', 'start: chargeTheScooter\nand wait: 10 min'],
  },
};

// --- memory ------------------------------------------------------------------------------------

const REMEMBER: StepSpec<'remember'> = {
  kind: 'remember',
  label: 'Remember',
  icon: 'save',
  says: 'Remember a value for later runs: a count, when something last happened, a reading.',
  fields: [
    { data: ['remember', 'name'], key: 'remember', type: { type: 'memory' }, required: true, label: 'What it remembers' },
    { data: ['remember', 'value'], key: 'as', type: { type: 'value' }, required: true, label: 'As' },
  ],
  blank: () => ({ remember: { name: '', value: { value: 0 } } }),
  line: (step, say) => `Remember ${say.memory(step.remember.name)} as ${say.expr(step.remember.value)}`,
  brief: (step, say) => `remember ${say.memory(step.remember.name)} as ${say.expr(step.remember.value)}`,
  docs: {
    summary: 'Remember a value — kept until a run remembers another, across runs and restarts — read as `memory.<name>`: one of what the automation declares under `memory`, in its kind and unit.',
    examples: ['remember: timesCharged\nas: memory.timesCharged + 1', 'remember: lastPower\nas: charger.power'],
  },
};

/** Every kind of step, by its key: the table everything that handles steps reads. */
export const STEP_KINDS: { readonly [K in StepKind]: StepSpec<K> } = {
  command: COMMAND,
  write: WRITE,
  wait: WAIT,
  waitUntil: WAIT_UNTIL,
  waitFor: WAIT_FOR,
  ensure: ENSURE,
  choose: CHOOSE,
  watch: WATCH,
  repeat: REPEAT,
  forEach: FOR_EACH,
  try: TRY,
  stop: STOP,
  start: START,
  remember: REMEMBER,
};

/** The order the editor offers them in. */
export const STEP_KIND_ORDER: readonly StepKind[] = ['command', 'write', 'wait', 'waitUntil', 'waitFor', 'ensure', 'choose', 'watch', 'repeat', 'forEach', 'try', 'stop', 'start', 'remember'];

/** Which kind a step is — by its key; one of no kind is an error, never taken for another. */
export function stepKind(step: Step): StepKind {
  const kind = STEP_KIND_ORDER.find((each) => each in step);
  if (!kind) throw new Error(`Not a step: ${Object.keys(step).join(', ') || 'nothing'}`);
  return kind;
}

/** A step's description. */
export const stepSpec = (step: Step): StepSpec => STEP_KINDS[stepKind(step)] as unknown as StepSpec;

/** A step's lists of steps within — its branches — each with its field. */
export const branchesOf = (step: Step): { field: FieldSpec; steps: readonly Step[] }[] =>
  stepSpec(step).fields.flatMap((field) => {
    if (field.type.type !== 'steps') return [];
    const steps = field.data.reduce<unknown>((at, key) => (at && typeof at === 'object' ? (at as Record<string, unknown>)[key] : undefined), step);
    return [{ field, steps: (steps as readonly Step[] | undefined) ?? [] }];
  });
