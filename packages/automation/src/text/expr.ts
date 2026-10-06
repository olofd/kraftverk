import { isUnit, type Unit, type Value } from '@kraftverk/device-sdk';

import { isAcrossFn } from '../kinds/across.ts';
import { BUILTIN_ORDER, isBuiltin } from '../kinds/builtins.ts';
import { HISTORY_ORDER, isHistoryFn } from '../kinds/history.ts';
import { isSunEvent } from '../sun.ts';
import { RUN_FACTS, type CompareOp, type Expr, type MathOp, type RunFact } from '../rule.ts';

/*
  The rule language's expressions as text (docs/CONFIG.md): what a condition
  reads like in a configuration file — `charger.power > 50 W`,
  `station.charge < 15 % and not plug reachable`. A part's reading is named by
  its standard meaning's word (`charge`, `power`, `output`) or, a type's own,
  by its whole meaning (`station.acme.mode`). The text is only a way of
  writing an `Expr`: parsed, it is the expression the checker checks, the
  describer says and the engine runs. Printed, it is that expression again —
  `parseExpr(printExpr(e))` is `e` — or, for the few an expression cannot say
  (a list for a value), nothing: the file keeps those as data.

  Precedence, loosest first:
    c ? a : b                 one or the other
    a ?? b                    the first known
    or, and, not
    < <= > >= == !=, in [ ]   a comparison, or one of a list
    + -                       a sum
    * /                       a product
    -x                        the opposite
    an atom                   a value, a reading, `role reachable`,
                              `run.trigger`, `setting.low`, `memory.count`,
                              `time between 23:00 and 05:00`,
                              `min(a, b)` and the language's other functions,
                              `acme.weather.sunny(forecast, day = "tomorrow")`,
                              or parentheses.
  A number may carry a unit (`50 W`, `15 %`, `2 min`), one kraftverk knows
  (units.ts): it is kept with the number, and printed with it, as it was
  written. A number with no unit is in the unit of what it is beside.
*/

/** Where a text went wrong: a message, and how far into the text. */
export type ExprError = { message: string; offset: number };

/** A parsed expression, or where it went wrong. */
export type Parsed = { ok: true; expr: Expr } | { ok: false; error: ExprError };

type Token =
  | { kind: 'number'; value: number; unit: Unit | null; at: number }
  | { kind: 'time'; value: string; at: number }
  | { kind: 'string'; value: string; at: number }
  | { kind: 'name'; value: string; at: number }
  | { kind: 'symbol'; value: string; at: number }
  | { kind: 'end'; at: number };

/** The language's own words: never a role's name. */
/** The language's own words: none names a role, nor what a "for each" calls each part. */
export const KEYWORDS: ReadonlySet<string> = new Set(['and', 'or', 'not', 'in', 'true', 'false', 'null', 'reachable', 'time', 'between', 'run', 'setting', 'memory', 'sunrise', 'sunset', 'before', 'after']);
const COMPARE: Record<string, CompareOp> = { '<': 'lt', '<=': 'le', '>': 'gt', '>=': 'ge', '==': 'eq', '!=': 'ne' };
const COMPARE_TEXT: Record<CompareOp, string> = { lt: '<', le: '<=', gt: '>', ge: '>=', eq: '==', ne: '!=' };
const MATH_TEXT: Record<MathOp, string> = { add: '+', subtract: '-', multiply: '*', divide: '/' };
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MEANING = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FUNCTION_ID = /^[A-Za-z_][A-Za-z0-9_-]*(\.[A-Za-z_][A-Za-z0-9_-]*)+$/;
const ARG_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const PARAM = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
const UNIT = /^[A-Za-z%°µ][A-Za-z0-9%°µ/²³·]*/;

class Failure extends Error {
  constructor(
    message: string,
    readonly offset: number
  ) {
    super(message);
  }
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  while (at < text.length) {
    const rest = text.slice(at);
    const space = /^\s+/.exec(rest);
    if (space) {
      at += space[0].length;
      continue;
    }
    const time = /^\d{2}:\d{2}(?![\d:])/.exec(rest);
    if (time) {
      if (!CLOCK.test(time[0])) throw new Failure(`${time[0]} is not a time of day`, at);
      tokens.push({ kind: 'time', value: time[0], at });
      at += time[0].length;
      continue;
    }
    const number = /^\d+(\.\d+)?/.exec(rest);
    if (number) {
      const start = at;
      at += number[0].length;
      // A unit after it, a space or none between: "50 W", "15%". Not a word of the language.
      const gap = /^\s*/.exec(text.slice(at))![0].length;
      const unit = UNIT.exec(text.slice(at + gap));
      let written: Unit | null = null;
      // "min" is minutes after a number — unless it opens "min(", the lowest of some.
      const minutes = unit?.[0] === 'min' && !/^\s*\(/.test(text.slice(at + gap + 3));
      if (unit && !KEYWORDS.has(unit[0]) && (unit[0] !== 'min' || minutes)) {
        const word = unit[0];
        if (!isUnit(word)) throw new Failure(`"${word}" is not a unit kraftverk knows: W, kWh, %, °C, min …`, at + gap);
        written = word;
        at += gap + word.length;
      }
      tokens.push({ kind: 'number', value: Number(number[0]), unit: written, at: start });
      continue;
    }
    if (rest[0] === '"') {
      const end = /^"(?:[^"\\]|\\.)*"/.exec(rest);
      if (!end) throw new Failure('A text is not closed: it needs its "', at);
      tokens.push({ kind: 'string', value: JSON.parse(end[0]) as string, at });
      at += end[0].length;
      continue;
    }
    const name = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(rest);
    if (name) {
      tokens.push({ kind: 'name', value: name[0], at });
      at += name[0].length;
      continue;
    }
    const symbol = /^(\?\?|<=|>=|==|!=|<|>|\+|-|\*|\/|\?|:|\(|\)|\[|\]|,|\.|=)/.exec(rest);
    if (symbol) {
      tokens.push({ kind: 'symbol', value: symbol[0], at });
      at += symbol[0].length;
      continue;
    }
    throw new Failure(`"${rest[0]}" is not part of the language`, at);
  }
  tokens.push({ kind: 'end', at: text.length });
  return tokens;
}

/** Reads an expression's text; every problem with where it is. */
export function parseExpr(text: string): Parsed {
  let tokens: Token[];
  try {
    tokens = tokenize(text);
  } catch (error) {
    return { ok: false, error: { message: (error as Failure).message, offset: (error as Failure).offset } };
  }
  let index = 0;
  const peek = () => tokens[index]!;
  const next = () => tokens[index++]!;
  const isSymbol = (value: string, token = peek()) => token.kind === 'symbol' && token.value === value;
  const isWord = (value: string, token = peek()) => token.kind === 'name' && token.value === value;
  const expect = (value: string, what: string) => {
    if (!(isSymbol(value) || isWord(value))) throw new Failure(`Expected ${what}`, peek().at);
    next();
  };
  const describe = (token: Token) => (token.kind === 'end' ? 'the end' : `"${'value' in token ? String(token.value) : ''}"`);

  const ternary = (): Expr => {
    const condition = either();
    if (!isSymbol('?')) return condition;
    next();
    const then = ternary();
    expect(':', '":" and the value when it does not hold');
    return { if: condition, then, else: ternary() };
  };
  const either = (): Expr => {
    const first = or();
    if (!isSymbol('??')) return first;
    const parts: Expr[] = [first];
    while (isSymbol('??')) (next(), parts.push(or()));
    return { either: parts };
  };
  const or = (): Expr => {
    const first = and();
    if (!isWord('or')) return first;
    const any: Expr[] = [first];
    while (isWord('or')) (next(), any.push(and()));
    return { any };
  };
  const and = (): Expr => {
    const first = not();
    if (!isWord('and')) return first;
    const all: Expr[] = [first];
    while (isWord('and')) (next(), all.push(not()));
    return { all };
  };
  const not = (): Expr => {
    if (isWord('not')) {
      next();
      return { not: not() };
    }
    return compare();
  };
  const compare = (): Expr => {
    const left = sum();
    const token = peek();
    if (token.kind === 'symbol' && token.value in COMPARE) {
      next();
      const right = sum();
      const after = peek();
      if ((after.kind === 'symbol' && after.value in COMPARE) || isWord('in', after)) throw new Failure('One comparison at a time: join two with "and"', after.at);
      return { compare: COMPARE[token.value]!, left, right };
    }
    if (isWord('in')) {
      next();
      return { item: left, in: list() };
    }
    return left;
  };
  const list = (): Expr[] => {
    expect('[', '"[" and the values it may be, "," between them');
    const items: Expr[] = [];
    if (!isSymbol(']')) {
      items.push(ternary());
      while (isSymbol(',')) (next(), items.push(ternary()));
    }
    expect(']', 'a "]" to close the list');
    return items;
  };
  const sum = (): Expr => {
    let left = product();
    while (isSymbol('+') || isSymbol('-')) {
      const op: MathOp = (next() as { value: string }).value === '+' ? 'add' : 'subtract';
      left = { math: op, left, right: product() };
    }
    return left;
  };
  const product = (): Expr => {
    let left = unary();
    while (isSymbol('*') || isSymbol('/')) {
      const op: MathOp = (next() as { value: string }).value === '*' ? 'multiply' : 'divide';
      left = { math: op, left, right: unary() };
    }
    return left;
  };
  const unary = (): Expr => {
    if (!isSymbol('-')) return atom();
    next();
    // A number written negative is that number: "-5 W". Anything else, its opposite: "-meter.power".
    const number = peek();
    if (number.kind === 'number') {
      next();
      return number.unit ? { value: -number.value, unit: number.unit } : { value: -number.value };
    }
    return { negate: unary() };
  };
  /** A value — or a length of time before or after the sun: "30 min before sunset", "setting.lead after sunrise". */
  const atom = (): Expr => {
    const got = primary();
    if (!isWord('before') && !isWord('after')) return got;
    const before = isWord('before');
    next();
    const event = next();
    if (event.kind !== 'name' || !isSunEvent(event.value)) throw new Failure(`Expected sunrise or sunset after "${before ? 'before' : 'after'}"`, event.at);
    return { sun: event.value, offset: { by: got, before } };
  };
  const primary = (): Expr => {
    const token = next();
    switch (token.kind) {
      case 'number':
        return token.unit ? { value: token.value, unit: token.unit } : { value: token.value };
      case 'time':
        return { value: token.value };
      case 'string':
        return { value: token.value };
      case 'symbol': {
        if (token.value === '(') {
          const inner = ternary();
          expect(')', 'a ")" to close the "("');
          return inner;
        }
        throw new Failure(`Expected a value, a reading or "(" — not ${describe(token)}`, token.at);
      }
      case 'name':
        return named(token);
      case 'end':
        throw new Failure('It ends where a value was expected', token.at);
    }
  };
  const named = (token: Extract<Token, { kind: 'name' }>): Expr => {
    switch (token.value) {
      case 'true':
        return { value: true };
      case 'false':
        return { value: false };
      case 'null':
        return { value: null };
      case 'time': {
        expect('between', '"between" after "time"');
        const from = unary();
        expect('and', '"and" between the two times');
        const to = unary();
        return { within: { from, to } };
      }
      case 'run': {
        // What the run knows of itself: "run.trigger".
        expect('.', `"." and what of the run: ${RUN_FACTS.map((fact) => `run.${fact}`).join(', ')}`);
        const fact = next();
        if (fact.kind !== 'name' || !(RUN_FACTS as readonly string[]).includes(fact.value)) throw new Failure(`A run knows its ${RUN_FACTS.join(', ')}`, fact.at);
        // What the event that started it carried: "run.event.voltage".
        if (fact.value === 'event' && isSymbol('.')) {
          next();
          const field = next();
          if (field.kind !== 'name' || !NAME.test(field.value)) throw new Failure('Expected what the event carried after "run.event."', field.at);
          return { run: 'event', field: field.value };
        }
        return { run: fact.value as RunFact };
      }
      case 'sunrise':
      case 'sunset':
        // When the sun rises or sets: a time of day.
        return { sun: token.value };
      case 'setting': {
        // One of the rule's settings: "setting.low".
        expect('.', '"." and the setting\'s name: setting.low');
        const name = next();
        if (name.kind !== 'name' || !PARAM.test(name.value)) throw new Failure('Expected a setting\'s name after "setting."', name.at);
        return { param: name.value };
      }
      case 'memory': {
        // What the rule remembers: "memory.timesCharged".
        expect('.', '"." and what it remembers: memory.timesCharged');
        const name = next();
        if (name.kind !== 'name' || !PARAM.test(name.value)) throw new Failure('Expected what it remembers after "memory."', name.at);
        return { memory: name.value };
      }
    }
    if (KEYWORDS.has(token.value)) throw new Failure(`"${token.value}" cannot start a value`, token.at);
    // Each part of a group, taken together: "any(c in chargers: c.power > 10 W)" — a name for each part, its group, what is said of each.
    if (isSymbol('(') && isAcrossFn(token.value) && tokens[index + 1]?.kind === 'name' && isWord('in', tokens[index + 2])) {
      next();
      const each = next();
      if (each.kind !== 'name' || !NAME.test(each.value)) throw new Failure('Expected a name for each part', each.at);
      next();
      const group = next();
      if (group.kind !== 'name' || !NAME.test(group.value)) throw new Failure(`Expected the group after "${each.value} in"`, group.at);
      expect(':', `":" and what is said of each: "${token.value}(${each.value} in ${group.value}: ${each.value}.power > 10 W)"`);
      const of = ternary();
      expect(')', `a ")" to close ${token.value}(`);
      return { across: token.value, as: each.value, group: group.value, of };
    }
    // A reading over the time just gone: "average(station.charge, 1 h)" — what it reads, then how long.
    if (isSymbol('(') && isHistoryFn(token.value)) {
      next();
      const of = ternary();
      if (!('read' in of)) throw new Failure(`${token.value}( looks back at a reading: "${token.value}(station.charge, 1 h)"`, token.at);
      expect(',', `"," and how long it looks back: "${token.value}(station.charge, 1 h)"`);
      const over = ternary();
      expect(')', `a ")" to close ${token.value}(`);
      return { history: token.value, of: of.read, over };
    }
    // One of the language's own functions: "min(a, b)".
    if (isSymbol('(')) {
      if (!isBuiltin(token.value)) throw new Failure(`"${token.value}" is not a function: ${BUILTIN_ORDER.join(', ')}; over time ${HISTORY_ORDER.join(', ')} — or a package's, by its whole id`, token.at);
      next();
      const args: Expr[] = [];
      if (!isSymbol(')')) {
        args.push(ternary());
        while (isSymbol(',')) (next(), args.push(ternary()));
      }
      expect(')', `a ")" to close ${token.value}(`);
      return { apply: token.value, args };
    }
    if (isWord('reachable')) {
      if (!NAME.test(token.value)) throw new Failure(`"${token.value}" is not a role's name: letters, digits and _ only`, token.at);
      next();
      return { reachable: token.value };
    }
    if (!isSymbol('.')) throw new Failure(`After the role "${token.value}": what it reports ("${token.value}.charge"), or "reachable"`, peek().at);
    // A dotted name: what a role's part reports — "station.charge" — or, called, a package's function.
    const segments: { value: string; at: number }[] = [];
    while (isSymbol('.')) {
      next();
      const segment = next();
      if (segment.kind !== 'name') throw new Failure('Expected the next part of a name after "."', segment.at);
      segments.push(segment);
    }
    if (isSymbol('(')) return call([token.value, ...segments.map((each) => each.value)].join('.'), token.at);
    if (!NAME.test(token.value)) throw new Failure(`"${token.value}" is not a role's name: letters, digits and _ only`, token.at);
    const bad = segments.find((each) => !NAME.test(each.value));
    if (bad) throw new Failure(`"${bad.value}" is not part of a meaning: letters, digits and _ only`, bad.at);
    return { read: { role: token.value, means: segments.map((each) => each.value).join('.') } };
  };
  const call = (id: string, at: number): Expr => {
    if (!FUNCTION_ID.test(id)) throw new Failure(`"${id}" is not a function's id: "package.name"`, at);
    expect('(', '"(" and the role it reads');
    const role = next();
    if (role.kind !== 'name' || !NAME.test(role.value) || KEYWORDS.has(role.value)) throw new Failure('Expected the role the function reads', role.at);
    const args: Record<string, Expr> = {};
    while (isSymbol(',')) {
      next();
      const name = next();
      if (name.kind !== 'name' || !ARG_NAME.test(name.value)) throw new Failure('Expected an argument\'s name', name.at);
      expect('=', `"=" after "${name.value}"`);
      args[name.value] = ternary();
    }
    expect(')', 'a ")" to close the call');
    return Object.keys(args).length ? { call: id, role: role.value, args } : { call: id, role: role.value };
  };

  try {
    const expr = ternary();
    const after = peek();
    if (after.kind !== 'end') throw new Failure(`Nothing more was expected here, but there is ${describe(after)}`, after.at);
    return { ok: true, expr };
  } catch (error) {
    if (!(error instanceof Failure)) throw error;
    return { ok: false, error: { message: error.message, offset: error.offset } };
  }
}

/** How tightly each kind binds, loosest first: what decides where parentheses go. */
const LEVEL = { ternary: 1, either: 2, or: 3, and: 4, not: 5, compare: 6, sum: 7, product: 8, unary: 9, atom: 10 } as const;

const isPrintableValue = (value: Value): boolean => value === null || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string';

/**
 * An expression as its text, or null when text cannot say it — a list or a
 * record for a value, a name the text cannot write. Each number with the
 * unit it was written in.
 */
export function printExpr(expr: Expr): string | null {
  try {
    return print(expr, 0);
  } catch (error) {
    if (error instanceof Unprintable) return null;
    throw error;
  }
}

class Unprintable extends Error {}

/**
 * A number in plain digits, as it is read back: never `1e-7`, whose `e`
 * would be read as a unit, and the rest as a sum.
 */
function plainDigits(value: number): string {
  const text = String(value);
  const match = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(text);
  if (!match) return text;
  const [, sign, lead, rest = '', exponent] = match;
  const digits = lead! + rest;
  const point = 1 + Number(exponent);
  if (point <= 0) return `${sign}0.${'0'.repeat(-point)}${digits}`;
  if (point >= digits.length) return `${sign}${digits}${'0'.repeat(point - digits.length)}`;
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

/** A role's name as the text can say it: never one of the language's words. */
const roleText = (role: string): string => {
  if (!NAME.test(role) || KEYWORDS.has(role)) throw new Unprintable();
  return role;
};

function print(expr: Expr, need: number): string {
  const wrap = (text: string, level: number) => (level < need ? `(${text})` : text);
  if ('value' in expr) {
    const { value, unit } = expr;
    if (!isPrintableValue(value)) throw new Unprintable();
    if (typeof value === 'number') {
      if (unit !== undefined && !isUnit(unit)) throw new Unprintable();
      // A negative number reads as one — "-5" — and as a unary, so "x - -5" stays a sum of two.
      return wrap(`${plainDigits(value)}${unit ? ` ${unit}` : ''}`, value < 0 ? LEVEL.unary : LEVEL.atom);
    }
    if (typeof value === 'string') return CLOCK.test(value) ? value : JSON.stringify(value);
    return String(value);
  }
  if ('param' in expr) {
    if (!PARAM.test(expr.param)) throw new Unprintable();
    return `setting.${expr.param}`;
  }
  if ('memory' in expr) {
    if (!PARAM.test(expr.memory)) throw new Unprintable();
    return `memory.${expr.memory}`;
  }
  if ('read' in expr) {
    if (!MEANING.test(expr.read.means)) throw new Unprintable();
    return `${roleText(expr.read.role)}.${expr.read.means}`;
  }
  if ('reachable' in expr) return `${roleText(expr.reachable)} reachable`;
  if ('run' in expr) {
    if (!RUN_FACTS.includes(expr.run)) throw new Unprintable();
    if (expr.field !== undefined) {
      if (expr.run !== 'event' || !NAME.test(expr.field)) throw new Unprintable();
      return `run.event.${expr.field}`;
    }
    return `run.${expr.run}`;
  }
  if ('sun' in expr) {
    if (!isSunEvent(expr.sun)) throw new Unprintable();
    return expr.offset ? `${print(expr.offset.by, LEVEL.unary)} ${expr.offset.before ? 'before' : 'after'} ${expr.sun}` : expr.sun;
  }
  if ('within' in expr) return `time between ${print(expr.within.from, LEVEL.unary)} and ${print(expr.within.to, LEVEL.unary)}`;
  if ('call' in expr) {
    if (!FUNCTION_ID.test(expr.call)) throw new Unprintable();
    const args = Object.entries(expr.args ?? {}).map(([name, arg]) => {
      if (!ARG_NAME.test(name) || KEYWORDS.has(name)) throw new Unprintable();
      return `${name} = ${print(arg, LEVEL.ternary)}`;
    });
    return `${expr.call}(${[roleText(expr.role), ...args].join(', ')})`;
  }
  if ('across' in expr) {
    if (!isAcrossFn(expr.across) || !NAME.test(expr.as) || !NAME.test(expr.group)) throw new Unprintable();
    return `${expr.across}(${expr.as} in ${expr.group}: ${print(expr.of, LEVEL.ternary)})`;
  }
  if ('history' in expr) {
    if (!isHistoryFn(expr.history) || !NAME.test(expr.of.role) || !MEANING.test(expr.of.means)) throw new Unprintable();
    return `${expr.history}(${expr.of.role}.${expr.of.means}, ${print(expr.over, LEVEL.ternary)})`;
  }
  if ('apply' in expr) {
    if (!isBuiltin(expr.apply)) throw new Unprintable();
    return `${expr.apply}(${expr.args.map((arg) => print(arg, LEVEL.ternary)).join(', ')})`;
  }
  if ('compare' in expr) return wrap(`${print(expr.left, LEVEL.sum)} ${COMPARE_TEXT[expr.compare]} ${print(expr.right, LEVEL.sum)}`, LEVEL.compare);
  if ('item' in expr) return wrap(`${print(expr.item, LEVEL.sum)} in [${expr.in.map((each) => print(each, LEVEL.ternary)).join(', ')}]`, LEVEL.compare);
  if ('math' in expr) {
    // Left to right: on the left, its own level; on the right, tighter — "a - (b - c)" keeps its parentheses.
    const level = expr.math === 'add' || expr.math === 'subtract' ? LEVEL.sum : LEVEL.product;
    return wrap(`${print(expr.left, level)} ${MATH_TEXT[expr.math]} ${print(expr.right, level + 1)}`, level);
  }
  if ('negate' in expr) {
    // The opposite of a number written outright keeps its parentheses: "-(5)", never the number -5.
    const inner = 'value' in expr.negate && typeof expr.negate.value === 'number' ? `(${print(expr.negate, 0)})` : print(expr.negate, LEVEL.unary);
    return wrap(`-${inner}`, LEVEL.unary);
  }
  if ('if' in expr) return wrap(`${print(expr.if, LEVEL.either)} ? ${print(expr.then, LEVEL.ternary)} : ${print(expr.else, LEVEL.ternary)}`, LEVEL.ternary);
  if ('either' in expr) {
    if (expr.either.length < 2) throw new Unprintable();
    return wrap(expr.either.map((each) => print(each, LEVEL.or)).join(' ?? '), LEVEL.either);
  }
  if ('not' in expr) return wrap(`not ${print(expr.not, LEVEL.not)}`, LEVEL.not);
  if ('all' in expr) {
    // One alone, or none, is no "and": the file keeps it as data.
    if (expr.all.length < 2) throw new Unprintable();
    return wrap(expr.all.map((each) => print(each, LEVEL.not)).join(' and '), LEVEL.and);
  }
  if ('any' in expr) {
    if (expr.any.length < 2) throw new Unprintable();
    // An "and" within an "or" keeps its parentheses: a person reads it as it groups.
    return wrap(expr.any.map((each) => print(each, LEVEL.and + 0.5)).join(' or '), LEVEL.or);
  }
  throw new Unprintable();
}
