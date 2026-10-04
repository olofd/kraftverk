import { RUN_FACTS, type CompareOp, type Expr, type MathOp, type RunFact } from '../rule.ts';
import { standardMeaning, type Value } from '@kraftverk/device-sdk';

/*
  The rule language's expressions as text (docs/CONFIG.md): what a condition
  reads like in a configuration file — `charger.power.draw > 50 W`,
  `station.battery.soc < 15 % and not plug reachable`. The text is only a way
  of writing an `Expr`: parsed, it is the expression the checker checks, the
  describer says and the engine runs. Printed, it is that expression again —
  `parseExpr(printExpr(e))` is `e` — or, for the few an expression cannot say
  (a list for a value), nothing: the file keeps those as data.

  Precedence, loosest first: `or`, `and`, `not`, a comparison, `+ -`, and an
  atom — a value, a reading, `role reachable`, `run.trigger`, `time between … and …`,
  `min( , )`, `max( , )`, `call id(role, name = …)`, `$setting`, or
  parentheses. A number may carry a unit (`50 W`, `15 %`): it is kept beside
  the expression, with where it was written, and the rule reader checks it
  against what the other side reads — converting `2 kW` beside a reading in W
  to 2000, refusing `50 °C` beside one in W. The language's numbers are in the
  unit of what they are compared with.
*/

/** Where a text went wrong: a message, and how far into the text. */
export type ExprError = { message: string; offset: number };

/** A unit written after a number, and where in the text: what the rule reader checks it by. */
export type WrittenUnit = { unit: string; at: number };

/** A parsed expression, with the unit written after each number that had one, by the value it became. */
export type Parsed = { ok: true; expr: Expr; units: WeakMap<Expr, WrittenUnit> } | { ok: false; error: ExprError };

/** What printing may ask: the unit of what a role's part reads, so a number beside it says it. */
export type PrintContext = { unitOf?: (role: string, means: string) => string | null };

type Token =
  | { kind: 'number'; value: number; unit: string | null; at: number }
  | { kind: 'time'; value: string; at: number }
  | { kind: 'string'; value: string; at: number }
  | { kind: 'name'; value: string; at: number }
  | { kind: 'symbol'; value: string; at: number }
  | { kind: 'end'; at: number };

const KEYWORDS = new Set(['and', 'or', 'not', 'true', 'false', 'null', 'reachable', 'time', 'between', 'call', 'min', 'max', 'run']);
const COMPARE: Record<string, CompareOp> = { '<': 'lt', '<=': 'le', '>': 'gt', '>=': 'ge', '==': 'eq', '!=': 'ne' };
const COMPARE_TEXT: Record<CompareOp, string> = { lt: '<', le: '<=', gt: '>', ge: '>=', eq: '==', ne: '!=' };
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MEANING = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FUNCTION_ID = /^[A-Za-z_][A-Za-z0-9_-]*(\.[A-Za-z_][A-Za-z0-9_-]*)+$/;
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
      let written: string | null = null;
      // "min" is minutes after a number — unless it opens "min(", the lower of two.
      const minutes = unit?.[0] === 'min' && !/^\s*\(/.test(text.slice(at + gap + 3));
      if (unit && (!KEYWORDS.has(unit[0]) || minutes)) {
        written = unit[0];
        at += gap + unit[0].length;
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
    const symbol = /^(<=|>=|==|!=|<|>|\+|-|\(|\)|,|\.|=|\$)/.exec(rest);
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
  const units = new WeakMap<Expr, WrittenUnit>();
  let tokens: Token[];
  try {
    tokens = tokenize(text);
  } catch (error) {
    return { ok: false, error: { message: (error as Failure).message, offset: (error as Failure).offset } };
  }
  let index = 0;
  const peek = () => tokens[index]!;
  const next = () => tokens[index++]!;
  const isSymbol = (value: string) => peek().kind === 'symbol' && (peek() as { value: string }).value === value;
  const isWord = (value: string) => peek().kind === 'name' && (peek() as { value: string }).value === value;
  const expect = (value: string, what: string) => {
    if (!(isSymbol(value) || isWord(value))) throw new Failure(`Expected ${what}`, peek().at);
    next();
  };
  const describe = (token: Token) => (token.kind === 'end' ? 'the end' : `"${'value' in token ? String(token.value) : ''}"`);

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
      if (after.kind === 'symbol' && after.value in COMPARE) throw new Failure('One comparison at a time: join two with "and"', after.at);
      return { compare: COMPARE[token.value]!, left, right };
    }
    return left;
  };
  const sum = (): Expr => {
    let left = atom();
    while (isSymbol('+') || isSymbol('-')) {
      const op: MathOp = (next() as { value: string }).value === '+' ? 'add' : 'subtract';
      left = { math: op, left, right: atom() };
    }
    return left;
  };
  const atom = (): Expr => {
    const token = next();
    switch (token.kind) {
      case 'number': {
        const expr: Expr = { value: token.value };
        if (token.unit) units.set(expr, { unit: token.unit, at: token.at });
        return expr;
      }
      case 'time':
        return { value: token.value };
      case 'string':
        return { value: token.value };
      case 'symbol': {
        if (token.value === '(') {
          const inner = or();
          expect(')', 'a ")" to close the "("');
          return inner;
        }
        if (token.value === '-' && peek().kind === 'number') {
          const number = next() as Extract<Token, { kind: 'number' }>;
          const expr: Expr = { value: -number.value };
          if (number.unit) units.set(expr, { unit: number.unit, at: token.at });
          return expr;
        }
        if (token.value === '$') {
          const name = next();
          if (name.kind !== 'name' || !PARAM.test(name.value)) throw new Failure('Expected a setting\'s name after "$"', name.at);
          return { param: name.value };
        }
        throw new Failure(`Expected a value, a reading or "(" — not ${describe(token)}`, token.at);
      }
      case 'name': {
        switch (token.value) {
          case 'true':
            return { value: true };
          case 'false':
            return { value: false };
          case 'null':
            return { value: null };
          case 'time': {
            expect('between', '"between" after "time"');
            const from = atom();
            expect('and', '"and" between the two times');
            const to = atom();
            return { within: { from, to } };
          }
          case 'min':
          case 'max': {
            expect('(', `"(" after "${token.value}"`);
            const left = or();
            expect(',', 'a "," between the two');
            const right = or();
            expect(')', 'a ")" to close it');
            return { math: token.value, left, right };
          }
          case 'call':
            return call();
          case 'run': {
            // What the run knows of itself: "run.trigger".
            expect('.', `"." and what of the run: ${RUN_FACTS.map((fact) => `run.${fact}`).join(', ')}`);
            const fact = next();
            if (fact.kind !== 'name' || !(RUN_FACTS as readonly string[]).includes(fact.value)) throw new Failure(`A run knows its ${RUN_FACTS.join(', ')}`, fact.at);
            return { run: fact.value as RunFact };
          }
        }
        if (KEYWORDS.has(token.value)) throw new Failure(`"${token.value}" cannot start a value`, token.at);
        if (!NAME.test(token.value)) throw new Failure(`"${token.value}" is not a role's name: letters, digits and _ only`, token.at);
        // A role: "role reachable", or what it reads, "role.meaning".
        if (isWord('reachable')) {
          next();
          return { reachable: token.value };
        }
        if (!isSymbol('.')) throw new Failure(`After the role "${token.value}": what it reads ("${token.value}.battery.soc"), or "reachable"`, peek().at);
        const segments: string[] = [];
        while (isSymbol('.')) {
          next();
          const segment = next();
          if (segment.kind !== 'name' || !NAME.test(segment.value)) throw new Failure('Expected the next part of a meaning after "."', segment.at);
          segments.push(segment.value);
        }
        return { read: { role: token.value, means: segments.join('.') } };
      }
      case 'end':
        throw new Failure('It ends where a value was expected', token.at);
    }
  };
  const call = (): Expr => {
    // The id: names joined by dots, a dash allowed inside a name.
    const parts: string[] = [];
    const start = peek().at;
    do {
      if (parts.length) next();
      const part = next();
      if (part.kind !== 'name') throw new Failure('Expected the function\'s id after "call"', part.at);
      parts.push(part.value);
    } while (isSymbol('.'));
    const id = parts.join('.');
    if (!FUNCTION_ID.test(id)) throw new Failure(`"${id}" is not a function's id: "package.name"`, start);
    expect('(', '"(" and the role it reads');
    const role = next();
    if (role.kind !== 'name' || !NAME.test(role.value)) throw new Failure('Expected the role the function reads', role.at);
    const args: Record<string, Expr> = {};
    while (isSymbol(',')) {
      next();
      const name = next();
      if (name.kind !== 'name') throw new Failure('Expected an argument\'s name', name.at);
      expect('=', `"=" after "${name.value}"`);
      args[name.value] = or();
    }
    expect(')', 'a ")" to close the call');
    return Object.keys(args).length ? { call: id, role: role.value, args } : { call: id, role: role.value };
  };

  try {
    const expr = or();
    const after = peek();
    if (after.kind !== 'end') throw new Failure(`Nothing more was expected here, but there is ${describe(after)}`, after.at);
    return { ok: true, expr, units };
  } catch (error) {
    if (!(error instanceof Failure)) throw error;
    return { ok: false, error: { message: error.message, offset: error.offset } };
  }
}

/** How tightly each kind binds, loosest first: what decides where parentheses go. */
const LEVEL = { or: 1, and: 2, not: 3, compare: 4, sum: 5, atom: 6 } as const;

const levelOf = (expr: Expr): number =>
  'any' in expr ? LEVEL.or : 'all' in expr ? LEVEL.and : 'not' in expr ? LEVEL.not : 'compare' in expr ? LEVEL.compare : 'math' in expr && (expr.math === 'add' || expr.math === 'subtract') ? LEVEL.sum : LEVEL.atom;

/** The unit of a reading on either side of an expression: what a bare number beside it is in. */
/** The unit a standard meaning's readings are in — none for one that may be in several (a price's currency). */
export function standardUnit(means: string): string | null {
  const meaning = standardMeaning(means);
  return meaning && meaning.type === 'number' && !meaning.units?.length ? meaning.unit : null;
}

/** The unit what a reading is read in: the part's own word when known, else its standard meaning's — as the reader reads it. */
function unitBeside(expr: Expr, context: PrintContext): string | null {
  if ('read' in expr) return context.unitOf?.(expr.read.role, expr.read.means) ?? standardUnit(expr.read.means);
  if ('math' in expr) return unitBeside(expr.left, context) ?? unitBeside(expr.right, context);
  return null;
}

const isPrintableValue = (value: Value): boolean => value === null || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string';

/**
 * An expression as its text, or null when text cannot say it — a list or a
 * record for a value, a name the text cannot write. `unit`: what a number
 * here is in, from the reading beside it.
 */
export function printExpr(expr: Expr, context: PrintContext = {}): string | null {
  try {
    return print(expr, 0, context, null);
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

function print(expr: Expr, need: number, context: PrintContext, unit: string | null): string {
  const wrap = (text: string, level: number) => (level < need ? `(${text})` : text);
  if ('value' in expr) {
    const value = expr.value;
    if (!isPrintableValue(value)) throw new Unprintable();
    if (typeof value === 'number') {
      const text = `${plainDigits(value)}${unit ? (unit === '%' ? ' %' : ` ${unit}`) : ''}`;
      // A negative number in a sum reads as one: "-5", not "- 5".
      return text;
    }
    if (typeof value === 'string') return CLOCK.test(value) ? value : JSON.stringify(value);
    return String(value);
  }
  if ('param' in expr) {
    if (!PARAM.test(expr.param)) throw new Unprintable();
    return `$${expr.param}`;
  }
  if ('read' in expr) {
    if (!NAME.test(expr.read.role) || KEYWORDS.has(expr.read.role) || !MEANING.test(expr.read.means)) throw new Unprintable();
    return `${expr.read.role}.${expr.read.means}`;
  }
  if ('reachable' in expr) {
    if (!NAME.test(expr.reachable) || KEYWORDS.has(expr.reachable)) throw new Unprintable();
    return `${expr.reachable} reachable`;
  }
  if ('run' in expr) {
    if (!RUN_FACTS.includes(expr.run)) throw new Unprintable();
    return `run.${expr.run}`;
  }
  if ('within' in expr) return `time between ${print(expr.within.from, LEVEL.atom, context, null)} and ${print(expr.within.to, LEVEL.atom, context, null)}`;
  if ('call' in expr) {
    if (!FUNCTION_ID.test(expr.call) || !NAME.test(expr.role) || KEYWORDS.has(expr.role)) throw new Unprintable();
    const args = Object.entries(expr.args ?? {}).map(([name, arg]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name) || KEYWORDS.has(name)) throw new Unprintable();
      return `${name} = ${print(arg, LEVEL.or, context, null)}`;
    });
    return `call ${expr.call}(${[expr.role, ...args].join(', ')})`;
  }
  if ('compare' in expr) {
    const beside = unitBeside(expr.left, context) ?? unitBeside(expr.right, context);
    return wrap(`${print(expr.left, LEVEL.sum, context, beside)} ${COMPARE_TEXT[expr.compare]} ${print(expr.right, LEVEL.sum, context, beside)}`, LEVEL.compare);
  }
  if ('math' in expr) {
    const beside = unit ?? unitBeside(expr, context);
    if (expr.math === 'min' || expr.math === 'max') return `${expr.math}(${print(expr.left, LEVEL.or, context, beside)}, ${print(expr.right, LEVEL.or, context, beside)})`;
    // Left to right: a sum on the left needs nothing, one on the right its parentheses.
    return wrap(`${print(expr.left, LEVEL.sum, context, beside)} ${expr.math === 'add' ? '+' : '-'} ${print(expr.right, LEVEL.atom, context, beside)}`, LEVEL.sum);
  }
  if ('not' in expr) return wrap(`not ${print(expr.not, LEVEL.not, context, null)}`, LEVEL.not);
  if ('all' in expr) {
    // One alone, or none, is no "and": the file keeps it as data.
    if (expr.all.length < 2) throw new Unprintable();
    return wrap(expr.all.map((each) => print(each, LEVEL.not, context, null)).join(' and '), LEVEL.and);
  }
  if ('any' in expr) {
    if (expr.any.length < 2) throw new Unprintable();
    return wrap(expr.any.map((each) => print(each, LEVEL.and + 0.5, context, null)).join(' or '), LEVEL.or);
  }
  throw new Unprintable();
}

/** Whether an expression's level is what `levelOf` says: exported for the rules' printer, which nests them. */
export { levelOf };
