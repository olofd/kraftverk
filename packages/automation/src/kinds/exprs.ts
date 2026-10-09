import type { Expr } from '../rule.ts';
import type { KindDocs } from './spec.ts';

/*
  The language's expressions, as data: each kind once — the expressions it
  holds (its children), how it is rebuilt with others in their place, and its
  page in the reference. What walks an expression — what it reads, its
  settings settled, the functions it asks — walks it by these, and what must
  treat each kind its own way (the checker, the words, the text form, the
  evaluator) does it in a switch over every kind, which does not compile with
  one left out.
*/

export type ExprKind = 'value' | 'param' | 'memory' | 'variable' | 'input' | 'read' | 'history' | 'distance' | 'sun' | 'across' | 'call' | 'apply' | 'script' | 'compare' | 'math' | 'negate' | 'if' | 'either' | 'in' | 'all' | 'any' | 'not' | 'reachable' | 'within' | 'run' | 'presentAt';

/** An expression of one kind. */
export type ExprOf<K extends ExprKind> = K extends ExprKind ? Extract<Expr, Record<K, unknown>> : never;

export type ExprSpec<K extends ExprKind = ExprKind> = {
  kind: K;
  /** What the reference calls it. */
  label: string;
  /** The expressions it holds, in order. */
  children: (expr: ExprOf<K>) => readonly Expr[];
  /** It again, with these in its children's places — the same number, in the same order. */
  rebuild: (expr: ExprOf<K>, children: readonly Expr[]) => ExprOf<K>;
  docs: KindDocs;
};

const leaf = <K extends ExprKind>(kind: K, label: string, docs: KindDocs): ExprSpec<K> => ({ kind, label, children: () => [], rebuild: (expr) => expr, docs });

const two = <K extends 'compare' | 'math'>(kind: K, label: string, docs: KindDocs): ExprSpec<K> => ({
  kind,
  label,
  children: (expr) => [(expr as { left: Expr }).left, (expr as { right: Expr }).right],
  rebuild: (expr, [left, right]) => ({ ...expr, left: left!, right: right! }),
  docs,
});

/** Every kind of expression, by its key. */
export const EXPR_KINDS: { readonly [K in ExprKind]: ExprSpec<K> } = {
  value: leaf('value', 'A value', { summary: 'A number — with its unit beside a reading, `50 W`, `15 %` — a time of day, `07:00`, text in quotes, `true` or `false`.', examples: ['50 W', '"eco"', '07:00'] }),
  param: leaf('param', 'A setting', { summary: 'One of the rule’s settings, by its name: a recipe’s, before it is copied into an automation.', examples: ['setting.low'] }),
  input: leaf('input', 'What it was given', { summary: 'One of the automation’s inputs, as the step that started the run gave it — or, not given, its default.', examples: ['given.level'] }),
  memory: leaf('memory', 'What it remembers', { summary: 'A value it remembers, as a run last left it — or, before any did, as it starts: kept across runs and restarts.', examples: ['memory.timesCharged'] }),
  variable: leaf('variable', 'A home’s variable', {
    summary:
      'One of a home’s variables, by its key, as it is now — a toggle, a number in its unit, a choice, words, a time of day, a count — set by automations, people and scripts: of `home`, the automation’s own, or a role a home fills. When one changes, an automation that reads it looks again, as for a reading.',
    examples: ['home.var.guests', 'home.var.dryerRuns >= 3', 'home.var.target'],
  }),
  read: leaf('read', 'A reading', {
    summary:
      'What the part filling a role reports now, by what it means: a standard meaning, or a type’s own. Unknown when it has not said, or said too long ago. Of a place — a role a place fills, or `home`, the automation’s own — what is so of it now: `people`, how many of the family are there, as far as each shares; `occupied`, whether anyone is, whoever they are; `presence` and `day`, a home’s mode on each axis, by its key.',
    examples: ['station.charge', 'charger.power', 'home.people == 0', 'bathroom.occupied', 'home.presence == "vacation"', 'home.day == "night"'],
  }),
  presentAt: leaf('presentAt', 'Someone somewhere', {
    summary:
      'Whether a person is at a place now, as far as they share — a home or a zone by where what they carry says they are, a room by a signal that tells people apart: a role a person fills, or what `any(p in children: …)` calls each of several; a role a place fills, or `home`. Unknown when they share too little to say.',
    examples: ['olof at home', 'not olof at work', 'any(p in children: p at school)', 'count(p in children: p at home) == 0'],
  }),
  history: {
    kind: 'history',
    label: 'Over the time just gone',
    children: (expr) => [expr.over],
    rebuild: (expr, [over]) => ({ ...expr, over: over! }),
    docs: {
      summary: 'A reading over the time just gone, from what the home kept of it: `average`, `lowest`, `highest`, `change` — how much it changed — or `ago`, what it was then. In the reading’s unit; the time a number or a setting, a minute to two weeks. Unknown when nothing was kept for that time.',
      examples: ['average(station.charge, 1 h)', 'change(station.charge, 30 min) > 5 %', 'ago(charger.power, 10 min)'],
    },
  },
  distance: leaf('distance', 'How far', {
    summary:
      'How far the position a part reports is from the home — or from another part’s, given a second — over the Earth’s surface: a number in m, compared in any length. Unknown when either position is, or the home has not said where it is.',
    examples: ['distance(phone.position) < 500 m', 'distance(phone.position) > 2 km', 'distance(phone.position, car.position) < 50 m'],
  }),
  call: {
    kind: 'call',
    label: 'Ask a package',
    children: (expr) => Object.values(expr.args ?? {}),
    rebuild: (expr, children) => (expr.args ? { ...expr, args: Object.fromEntries(Object.keys(expr.args).map((name, index) => [name, children[index]!])) } : expr),
    docs: { summary: 'A function a package contributes, over the part filling a role: what the forecast says of tomorrow, the price’s rank. Only where a run may wait for its answer.', examples: ['acme.weather.sunny(forecast, day = "tomorrow")'] },
  },
  apply: {
    kind: 'apply',
    label: 'A function of the language',
    children: (expr) => expr.args,
    rebuild: (expr, children) => ({ ...expr, args: children }),
    docs: { summary: 'One of the language’s own functions — min, max, clamp, round, floor, ceil, abs — on numbers, each with its unit; the answer in the first one’s unit.', examples: ['min(station.charge, 80 %)', 'clamp(charger.power, 0 W, 2 kW)'] },
  },
  script: {
    kind: 'script',
    label: 'A function of a script',
    children: (expr) => expr.args,
    rebuild: (expr, children) => ({ ...expr, args: children }),
    docs: {
      summary: 'One of the functions of the script filling a role (docs/PLAN-SCRIPTS.md), its arguments in order: pure, so it may be called anywhere a condition is looked at. Unknown when an argument is, or where no engine runs scripts.',
      examples: ['feel.feelsLike(kitchen.temperature, kitchen.humidity) > 25 °C'],
    },
  },
  compare: two('compare', 'A comparison', { summary: 'Two values compared: `<`, `<=`, `>`, `>=`, `==`, `!=`. Unknown when either is.', examples: ['station.charge < 15 %'] }),
  math: two('math', 'Arithmetic', {
    summary: 'A number from two: `+ - * /`. A sum is in one unit; a product or quotient in the unit the two make — a power for a time an energy, a percentage a share of what it multiplies. Unknown when either is.',
    examples: ['station.charge + 10 %', 'station.capacity * 50 %', 'charger.power * 2 h'],
  }),
  negate: {
    kind: 'negate',
    label: 'The opposite',
    children: (expr) => [expr.negate],
    rebuild: (_expr, [inner]) => ({ negate: inner! }),
    docs: { summary: 'A number’s opposite, in its unit.', examples: ['-meter.power'] },
  },
  if: {
    kind: 'if',
    label: 'One or the other',
    children: (expr) => [expr.if, expr.then, expr.else],
    rebuild: (_expr, [condition, then, otherwise]) => ({ if: condition!, then: then!, else: otherwise! }),
    docs: { summary: 'The first value when the condition holds, the second when it does not; unknown when it cannot be told.', examples: ['price.priceRank <= 4 ? 2 kW : 500 W'] },
  },
  either: {
    kind: 'either',
    label: 'The first known',
    children: (expr) => expr.either,
    rebuild: (_expr, children) => ({ either: children }),
    docs: { summary: 'The first of its values that is known: a reading gone quiet, a value in its place.', examples: ['outdoor.temperature ?? 10 °C'] },
  },
  in: {
    kind: 'in',
    label: 'One of',
    children: (expr) => [expr.item, ...expr.in],
    rebuild: (_expr, [item, ...options]) => ({ item: item!, in: options }),
    docs: { summary: 'Whether a value is one of a list: numbers in one unit, or texts.', examples: ['station.mode in ["eco", "boost"]'] },
  },
  all: {
    kind: 'all',
    label: 'All of',
    children: (expr) => expr.all,
    rebuild: (_expr, children) => ({ all: children }),
    docs: { summary: 'True when every part is: one false is enough to say no, and with none false, one unknown leaves it unknown.', examples: ['charger reachable and station.charge < 50 %'] },
  },
  any: {
    kind: 'any',
    label: 'Any of',
    children: (expr) => expr.any,
    rebuild: (_expr, children) => ({ any: children }),
    docs: { summary: 'True when any part is: one true is enough, and with none true, one unknown leaves it unknown.', examples: ['station.charge < 10 % or time between 23:00 and 05:00'] },
  },
  not: { kind: 'not', label: 'Not', children: (expr) => [expr.not], rebuild: (_expr, [inner]) => ({ not: inner! }), docs: { summary: 'True when its part is false, false when it is true; unknown stays unknown.', examples: ['not charger reachable'] } },
  reachable: leaf('reachable', 'Can be reached', { summary: 'Whether the part filling a role can be reached now: its holder says it is connected. Never unknown — not being reachable is the answer.', examples: ['charger reachable'] }),
  within: {
    kind: 'within',
    label: 'Time of day',
    children: (expr) => [expr.within.from, expr.within.to],
    rebuild: (_expr, [from, to]) => ({ within: { from: from!, to: to! } }),
    docs: { summary: 'Whether the owner’s clock is between two times of day, from the first up to the second — across midnight when the second comes first.', examples: ['time between 23:00 and 05:00'] },
  },
  across: {
    kind: 'across',
    label: 'Across a group',
    children: (expr) => [expr.of],
    rebuild: (expr, [of]) => ({ ...expr, of: of! }),
    docs: {
      summary: 'Something of each part of a group, taken together — `all`, `any`, `count`, `sum`, `average`, `lowest`, `highest` — each part called by a name of its own within it, as a role is. Unknown while it is for a part, unless one part settles it; `??` gives a part that may not say a value of its own.',
      examples: ['any(c in chargers: c.power > 10 W)', 'count(c in chargers: c reachable) < 2', 'sum(c in chargers: c.power ?? 0 W) > 2 kW'],
    },
  },
  sun: {
    kind: 'sun',
    label: 'The sun',
    children: (expr) => (expr.offset ? [expr.offset.by] : []),
    rebuild: (expr, [by]) => (expr.offset ? { ...expr, offset: { ...expr.offset, by: by! } } : expr),
    docs: {
      summary: 'When the sun rises or sets where the home is, on the automation’s clock — or so long before or after, a minute to twelve hours: a time of day, as `07:00` is, for `at` and `time between`. Unknown until the home has a place, and on a day the sun does not cross the horizon.',
      examples: ['sunset', '30 min before sunset', 'time between sunset and sunrise', 'time between 1 h after sunrise and setting.lead before sunset'],
    },
  },
  run: leaf('run', 'What the run knows', {
    summary:
      'What the run knows of itself: `run.trigger`, the id of the trigger that started it — `""` when none with an id did; `run.event`, the event a device raised that started it, and `run.event.voltage`, what it carried, as its device declares it — unknown when no event did; `run.who`, the name of the person whose arriving or leaving started it — `""` when none did.',
    examples: ['run.trigger == "low"', 'run.event.voltage < 200 V', 'run.who == "Anna"'],
  }),
};

/** The order the reference lists them in. */
export const EXPR_KIND_ORDER: readonly ExprKind[] = ['value', 'param', 'input', 'memory', 'variable', 'read', 'presentAt', 'history', 'distance', 'reachable', 'run', 'within', 'sun', 'across', 'call', 'apply', 'script', 'compare', 'in', 'math', 'negate', 'if', 'either', 'all', 'any', 'not'];

/** Which kind an expression is — by its key; one of no kind is an error, never taken for another. */
export function exprKind(expr: Expr): ExprKind {
  const kind = EXPR_KIND_ORDER.find((each) => each in expr);
  if (!kind) throw new Error(`Not an expression: ${Object.keys(expr).join(', ') || 'nothing'}`);
  return kind;
}

/** An expression's description. */
export const exprSpec = (expr: Expr): ExprSpec => EXPR_KINDS[exprKind(expr)] as unknown as ExprSpec;

/** The expressions an expression holds. */
export const childrenOf = (expr: Expr): readonly Expr[] => exprSpec(expr).children(expr);

/** An expression with each of its children changed by `change` — the same kind, a new object. */
export const mapChildren = (expr: Expr, change: (child: Expr) => Expr): Expr => {
  const spec = exprSpec(expr);
  const children = spec.children(expr);
  return children.length ? spec.rebuild(expr, children.map(change)) : expr;
};

/** Every expression within one, itself first, deepest last: what a walk visits. */
export function* expressionsIn(expr: Expr): Generator<Expr> {
  yield expr;
  for (const child of childrenOf(expr)) yield* expressionsIn(child);
}
