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

export type ExprKind = 'value' | 'param' | 'read' | 'call' | 'compare' | 'math' | 'all' | 'any' | 'not' | 'reachable' | 'within' | 'run';

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
  param: leaf('param', 'A setting', { summary: 'One of the rule’s settings, by its name: a recipe’s, before it is copied into an automation.', examples: ['$low'] }),
  read: leaf('read', 'A reading', { summary: 'What the part filling a role reports now, by what it means: a standard meaning, or a type’s own. Unknown when it has not said, or said too long ago.', examples: ['station.battery.soc', 'charger.power.draw'] }),
  call: {
    kind: 'call',
    label: 'Ask a package',
    children: (expr) => Object.values(expr.args ?? {}),
    rebuild: (expr, children) => (expr.args ? { ...expr, args: Object.fromEntries(Object.keys(expr.args).map((name, index) => [name, children[index]!])) } : expr),
    docs: { summary: 'A function a package contributes, over the part filling a role: what the forecast says of tomorrow, the price’s rank. Only where a run may wait for its answer.', examples: ['call acme.weather.sunny(forecast, day = "tomorrow")'] },
  },
  compare: two('compare', 'A comparison', { summary: 'Two values compared: `<`, `<=`, `>`, `>=`, `==`, `!=`. Unknown when either is.', examples: ['station.battery.soc < 15 %'] }),
  math: two('math', 'Arithmetic', { summary: 'A number from two, in one unit: their sum or difference, or the lower or higher of them. Unknown when either is.', examples: ['station.battery.soc + 10 %', 'min(station.battery.soc, 80 %)'] }),
  all: {
    kind: 'all',
    label: 'All of',
    children: (expr) => expr.all,
    rebuild: (_expr, children) => ({ all: children }),
    docs: { summary: 'True when every part is: one false is enough to say no, and with none false, one unknown leaves it unknown.', examples: ['charger reachable and station.battery.soc < 50 %'] },
  },
  any: {
    kind: 'any',
    label: 'Any of',
    children: (expr) => expr.any,
    rebuild: (_expr, children) => ({ any: children }),
    docs: { summary: 'True when any part is: one true is enough, and with none true, one unknown leaves it unknown.', examples: ['station.battery.soc < 10 % or time between 23:00 and 05:00'] },
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
  run: leaf('run', 'What the run knows', { summary: 'What the run knows of itself: `run.trigger`, the id of the trigger that started it — `""` when none with an id did.', examples: ['run.trigger == "low"'] }),
};

/** The order the reference lists them in. */
export const EXPR_KIND_ORDER: readonly ExprKind[] = ['value', 'param', 'read', 'reachable', 'run', 'within', 'call', 'compare', 'math', 'all', 'any', 'not'];

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
