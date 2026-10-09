/// <reference path="./sucrase-parser.d.ts" />
import { wordsOfName as wordsOf, type ScriptFunctionShape, type ScriptProblem, type ScriptShape, type ScriptStepShape } from '@kraftverk/automation';
import { isUnit, type ConfigField, type ConfigSchema, type Unit } from '@kraftverk/device-sdk';
import { parse } from 'sucrase/dist/esm/parser/index.js';
import { ContextualKeyword } from 'sucrase/dist/esm/parser/tokenizer/keywords.js';
import { TokenType as tt } from 'sucrase/dist/esm/parser/tokenizer/types.js';

/*
  What a script declares, read from what is written (docs/PLAN-SCRIPTS.md
  §8.4): its exported functions and their types, as TypeScript has them.

    export async function tidyUp(after: Duration, memory: Kept<Memory>): Promise<string>
    export function feelsLike(temp: Celsius, humidity: Percent): Celsius

  An `async function` is a step: it may read the home, act and wait, and is
  given its inputs by name. A plain `function` is a function: pure, its
  arguments in order, for a condition. Each parameter's type is one the
  language has — a number, in a unit or a duration, text, yes or no, a choice
  of words, an instant — and its doc comment says its title and its limits
  (`@min 1 min`); a step's `Kept<…>` parameter is what it remembers.

  Read by sucrase's own parser, not a compiler of types: only how the
  signature is written counts, so a hub reads a script wherever it runs, the
  phone too. The editor's TypeScript checks the rest.
*/

/** The language's types, by the name a script writes them with: each a number in its unit. */
export const UNIT_TYPES = {
  Watts: 'W',
  Kilowatts: 'kW',
  WattHours: 'Wh',
  KilowattHours: 'kWh',
  Amperes: 'A',
  Volts: 'V',
  Hertz: 'Hz',
  Percent: '%',
  Celsius: '°C',
  Fahrenheit: '°F',
  Kelvin: 'K',
  Meters: 'm',
  Kilometers: 'km',
  Lux: 'lx',
} as const satisfies Record<string, Unit>;

/** How the hub calls one of a script's exports: its parameters' names in order, and which of a step's is what it remembers. */
export type ScriptCall = { params: readonly string[]; memory: number | null };

/** A script's exports as written: what it declares, how each is called, and what is wrong with them. */
export type Signatures = { shape: ScriptShape; calls: Record<string, ScriptCall>; problems: ScriptProblem[] };

/** What a script's exports are named: as recipes and the language's own names are. */
const NAME = /^[a-z][A-Za-z0-9]*$/;

/** A type as written: only what a signature may say. */
type TypeNode =
  | { kind: 'name'; name: string; args: TypeNode[]; at: number }
  | { kind: 'string'; value: string; at: number }
  | { kind: 'literal'; text: string; at: number }
  | { kind: 'object'; members: Member[]; at: number }
  | { kind: 'union'; of: TypeNode[]; at: number };
type Member = { name: string; doc: Doc; type: TypeNode; at: number };

/** A doc comment: its words, and its tags — `@min 1 min`. */
type Doc = { text: string; tags: Record<string, string> };
const NO_DOC: Doc = { text: '', tags: {} };

/** Stops reading a signature: what is wrong, at an offset of the source. */
class Unreadable extends Error {
  constructor(
    message: string,
    readonly at: number
  ) {
    super(message);
  }
}

/** A doc comment's words and tags, as written in the last `/** … *\/` of a stretch of source. */
function docIn(between: string): Doc {
  const found = [...between.matchAll(/\/\*\*([\s\S]*?)\*\//g)].at(-1);
  if (!found) return NO_DOC;
  const lines = found[1]!.split('\n').map((line) => line.replace(/^\s*\*?\s?/, '').trim());
  const all = lines.join(' ').trim();
  const first = all.search(/(^|\s)@\w/);
  const text = (first === -1 ? all : all.slice(0, first)).trim();
  const tags: Record<string, string> = {};
  for (const tag of ` ${all.slice(first === -1 ? all.length : first)}`.matchAll(/\s@(\w+)\s*((?:(?!\s@\w)[\s\S])*)/g)) tags[tag[1]!] = tag[2]!.trim();
  return { text, tags };
}

/** A string literal's value, as written between its quotes: its escapes undone. */
const unquoted = (literal: string): string => literal.slice(1, -1).replace(/\\(.)/g, '$1');

/** A length of time as a tag says it — "90", "90 s", "1 min", "2 h" — in seconds. */
function secondsOf(text: string): number | null {
  const found = /^(-?\d+(?:\.\d+)?)\s*(s|sec|seconds?|min|minutes?|h|hours?|d|days?)?$/.exec(text.trim());
  if (!found) return null;
  const unit = found[2] ?? 's';
  const factor = unit.startsWith('d') ? 86_400 : unit.startsWith('h') ? 3_600 : unit.startsWith('m') ? 60 : 1;
  return Number(found[1]) * factor;
}

export function readSignatures(source: string): Signatures {
  const problems: ScriptProblem[] = [];
  const steps: Record<string, ScriptStepShape> = {};
  const functions: Record<string, ScriptFunctionShape> = {};
  const calls: Record<string, ScriptCall> = {};
  const tokens = parse(source, false, true, false).tokens;

  // Where an offset is, counted from 1: what a problem is placed by.
  const lineStarts = [0];
  for (let at = 0; at < source.length; at++) if (source.charCodeAt(at) === 10) lineStarts.push(at + 1);
  const placed = (message: string, offset: number): ScriptProblem => {
    let line = 0;
    while (line + 1 < lineStarts.length && lineStarts[line + 1]! <= offset) line++;
    return { message, line: line + 1, column: offset - lineStarts[line]! + 1 };
  };

  const text = (i: number): string => (tokens[i] ? source.slice(tokens[i]!.start, tokens[i]!.end) : '');
  const is = (i: number, type: tt): boolean => tokens[i]?.type === type;
  const keyword = (i: number, word: ContextualKeyword): boolean => is(i, tt.name) && tokens[i]!.contextualKeyword === word;
  /** The doc comment just before a token: between it and the token before. */
  const docBefore = (i: number): Doc => docIn(source.slice(i > 0 ? tokens[i - 1]!.end : 0, tokens[i]?.start ?? 0));
  const expect = (i: number, type: tt, what: string): number => {
    if (!is(i, type)) throw new Unreadable(`Expected ${what}`, tokens[i]?.start ?? source.length);
    return i + 1;
  };

  // The script's own types, by name: `type Mode = 'eco' | 'boost'`, `interface Memory { times: number }`.
  const named = new Map<string, number>();
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i]!.scopeDepth !== 0) continue;
    if ((keyword(i, ContextualKeyword._type) && is(i + 1, tt.name) && is(i + 2, tt.eq)) || (keyword(i, ContextualKeyword._interface) && is(i + 1, tt.name))) named.set(text(i + 1), i);
  }

  /** A type, from token i: what it is, and the token after it. */
  const typeAt = (i: number): [TypeNode, number] => {
    if (is(i, tt.bitwiseOR)) i++;
    const of: TypeNode[] = [];
    let node: TypeNode;
    [node, i] = primaryAt(i);
    of.push(node);
    while (is(i, tt.bitwiseOR)) {
      [node, i] = primaryAt(i + 1);
      of.push(node);
    }
    return [of.length === 1 ? of[0]! : { kind: 'union', of, at: of[0]!.at }, i];
  };
  const primaryAt = (i: number): [TypeNode, number] => {
    const at = tokens[i]?.start ?? source.length;
    if (is(i, tt.string)) return [{ kind: 'string', value: unquoted(text(i)), at }, i + 1];
    if (is(i, tt._void) || is(i, tt._null) || is(i, tt._true) || is(i, tt._false) || is(i, tt.num)) return [{ kind: 'literal', text: text(i), at }, i + 1];
    if (is(i, tt.braceL)) return objectAt(i);
    if (is(i, tt.name)) {
      const name = text(i);
      i++;
      const args: TypeNode[] = [];
      if (is(i, tt.lessThan)) {
        let arg: TypeNode;
        [arg, i] = typeAt(i + 1);
        args.push(arg);
        while (is(i, tt.comma)) {
          [arg, i] = typeAt(i + 1);
          args.push(arg);
        }
        i = expect(i, tt.greaterThan, '">"');
      }
      if (is(i, tt.bracketL)) throw new Unreadable('A list is not a type a step or function is given or gives yet', tokens[i]!.start);
      return [{ kind: 'name', name, args, at }, i];
    }
    throw new Unreadable(`"${text(i) || 'this'}" is not a type kraftverk reads here`, at);
  };
  const objectAt = (i: number): [TypeNode, number] => {
    const at = tokens[i]!.start;
    i = expect(i, tt.braceL, '"{"');
    const members: Member[] = [];
    while (!is(i, tt.braceR)) {
      // Read-only or not, a member is a member.
      if (text(i) === 'readonly' && is(i + 1, tt.name)) i++;
      if (!is(i, tt.name)) throw new Unreadable('Each of what it remembers is a name and its type: "times: number"', tokens[i]?.start ?? source.length);
      const doc = docBefore(i);
      const name = text(i);
      const memberAt = tokens[i]!.start;
      i++;
      if (is(i, tt.question)) i++;
      i = expect(i, tt.colon, '":" and its type');
      let type: TypeNode;
      [type, i] = typeAt(i);
      members.push({ name, doc, type, at: memberAt });
      if (is(i, tt.semi) || is(i, tt.comma)) i++;
    }
    return [{ kind: 'object', members, at }, i + 1];
  };

  /** A type of the script's own, by name, as the type it is: an interface as its object. */
  const resolved = (node: TypeNode, seen: ReadonlySet<string> = new Set()): TypeNode => {
    if (node.kind !== 'name' || node.args.length || !named.has(node.name) || seen.has(node.name)) return node;
    const i = named.get(node.name)!;
    const isInterface = keyword(i, ContextualKeyword._interface);
    if (isInterface && !is(i + 2, tt.braceL)) throw new Unreadable(`The interface ${node.name} is only its own members: no "extends", no type parameters`, tokens[i + 2]!.start);
    const [type] = isInterface ? objectAt(i + 2) : typeAt(i + 3);
    return resolved(type, new Set([...seen, node.name]));
  };

  /** A field of the language's, from a type and its doc comment — or why it cannot be. */
  const fieldOf = (node: TypeNode, doc: Doc, name: string, initial: string | null): ConfigField => {
    const type = resolved(node);
    const title = doc.text.replace(/\.$/, '').trim() || wordsOf(name);
    const presented = { title, ...(doc.tags.description ? { description: doc.tags.description } : {}) };
    // A value that may be missing: the type it is when it is there.
    const flat = (each: TypeNode): TypeNode[] => {
      const one = resolved(each);
      return one.kind === 'union' ? one.of.flatMap(flat) : [one];
    };
    const given = flat(type).filter((each) => !(each.kind === 'literal' && (each.text === 'null' || each.text === 'undefined')) && !(each.kind === 'name' && each.name === 'undefined'));
    const defaultText = doc.tags.default ?? initial;
    if (given.length > 1 || given[0]!.kind === 'string') {
      if (!given.every((each) => each.kind === 'string')) throw new Unreadable(`A choice is of words only: 'eco' | 'boost'`, type.at);
      const options = given.map((each) => ({ value: (each as { value: string }).value, label: wordsOf((each as { value: string }).value) }));
      const fallback = defaultText?.replace(/^['"]|['"]$/g, '');
      return { type: 'enum', ...presented, options, ...(fallback && options.some((option) => option.value === fallback) ? { default: fallback } : {}) };
    }
    const one = resolved(given[0]!);
    if (one.kind !== 'name') throw new Unreadable(`"${source.slice(one.at, one.at + 40).split(/[,)\n]/)[0]}" is not a type kraftverk reads here: number, string, boolean, a choice of words, Duration, Instant, or a number in a unit, as Celsius or Quantity<'W'>`, one.at);
    const numbered = (unit: Unit | null, duration: boolean): ConfigField => {
      const read = (tag: string): number | undefined => {
        const said = doc.tags[tag] ?? (tag === 'default' ? (initial ?? undefined) : undefined);
        if (said === undefined) return undefined;
        const value = duration ? secondsOf(said) : Number(said.replace(unit ?? '', '').trim());
        if (value === null || !Number.isFinite(value)) throw new Unreadable(`@${tag} "${said}" is not ${duration ? 'a length of time: 90 s, 5 min, 2 h' : 'a number'}`, one.at);
        return value;
      };
      const field: ConfigField = { type: 'number', ...presented, ...(unit ? { unit } : {}) };
      const min = read('min') ?? (duration ? 0 : undefined);
      if (min !== undefined) field.min = min;
      for (const tag of ['max', 'step', 'default'] as const) {
        const value = read(tag);
        if (value !== undefined) field[tag] = value;
      }
      if ('integer' in doc.tags) field.integer = true;
      return field;
    };
    switch (one.name) {
      case 'number':
        return numbered(null, false);
      case 'Duration':
        return numbered('s', true);
      case 'Quantity': {
        const unit = one.args[0];
        if (unit?.kind !== 'string' || !isUnit(unit.value)) throw new Unreadable(`Quantity<…> is in a unit kraftverk knows: Quantity<'W'>, Quantity<'°C'>`, unit?.at ?? one.at);
        return numbered(unit.value, false);
      }
      case 'string':
        return { type: 'string', ...presented, ...(defaultText ? { default: defaultText.replace(/^['"]|['"]$/g, '') } : {}) };
      case 'boolean':
        return { type: 'boolean', ...presented, ...(defaultText === 'true' || defaultText === 'false' ? { default: defaultText === 'true' } : {}) };
      case 'Instant':
        return { type: 'timestamp', ...presented };
      default:
        if (Object.hasOwn(UNIT_TYPES, one.name)) return numbered(UNIT_TYPES[one.name as keyof typeof UNIT_TYPES], false);
        throw new Unreadable(`${one.name} is not a type kraftverk reads here: number, string, boolean, a choice of words, Duration, Instant, or a number in a unit, as Celsius or Quantity<'W'>`, one.at);
    }
  };

  /** What a step keeps between runs, from its `Kept<…>`: each member a field, with what it starts as. */
  const memoryOf = (node: TypeNode): ConfigSchema => {
    const type = resolved(node);
    if (type.kind !== 'object') throw new Unreadable('What a step remembers is an object of names: Kept<{ times: number }>', type.at);
    const fields: ConfigSchema['fields'] = {};
    for (const member of type.members) {
      if (!NAME.test(member.name)) throw new Unreadable(`"${member.name}": a name is a word in camelCase, as "times"`, member.at);
      const field = fieldOf(member.type, member.doc, member.name, null);
      // What it starts as, before it has been kept: nothing, none, the first choice.
      if (field.default === undefined && field.type !== 'timestamp') {
        if (field.type === 'number') field.default = Math.min(Math.max(0, field.min ?? 0), field.max ?? Number.POSITIVE_INFINITY);
        else if (field.type === 'boolean') field.default = false;
        else if (field.type === 'string') field.default = '';
        else if (field.type === 'enum') field.default = field.options[0]!.value;
      }
      fields[member.name] = field;
    }
    return { fields };
  };

  /** What an export gives back: its return type, a step's out of its Promise; null when it gives nothing. */
  const answerOf = (node: TypeNode | null, step: boolean): ConfigField | null => {
    if (!node) return null;
    let type = node;
    if (type.kind === 'name' && type.name === 'Promise') {
      if (!step) throw new Unreadable('A function answers at once: make it an "async function" to make it a step', type.at);
      type = type.args[0] ?? { kind: 'literal', text: 'void', at: type.at };
    }
    if (type.kind === 'literal' && (type.text === 'void' || type.text === 'undefined')) return null;
    if (type.kind === 'name' && (type.name === 'void' || type.name === 'undefined')) return null;
    return fieldOf(type, NO_DOC, 'answer', null);
  };

  for (let i = 0; i < tokens.length; i++) {
    if (!is(i, tt._export) || tokens[i]!.scopeDepth !== 0) continue;
    const exportAt = tokens[i]!.start;
    const about = docBefore(i).text || null;
    let j = i + 1;
    // Types the script exports are its own business: only its functions are read.
    if (keyword(j, ContextualKeyword._type) || keyword(j, ContextualKeyword._interface)) continue;
    const isAsync = keyword(j, ContextualKeyword._async);
    if (isAsync) j++;
    if (!is(j, tt._function) || !is(j + 1, tt.name)) {
      problems.push(placed('Export only functions, each by its name: "export async function" for a step, "export function" for a function', exportAt));
      continue;
    }
    const name = text(j + 1);
    const nameAt = tokens[j + 1]!.start;
    if (!NAME.test(name)) problems.push(placed(`"${name}": a name is a word in camelCase, as "tidyUp"`, nameAt));
    try {
      j = expect(j + 2, tt.parenL, '"(" and its parameters');
      const params: { name: string; doc: Doc; type: TypeNode; initial: string | null; at: number }[] = [];
      while (!is(j, tt.parenR)) {
        const doc = docBefore(j);
        if (!is(j, tt.name)) throw new Unreadable('Name each parameter, with its type: "after: Duration"', tokens[j]?.start ?? source.length);
        const param = text(j);
        const at = tokens[j]!.start;
        j++;
        if (is(j, tt.question)) j++;
        if (!is(j, tt.colon)) throw new Unreadable(`Say what "${param}" is: "${param}: number", "${param}: Duration"`, at);
        let type: TypeNode;
        [type, j] = typeAt(j + 1);
        let initial: string | null = null;
        if (is(j, tt.eq)) {
          // To the next comma or the end, at its own depth: `= -1`, `= 5 * 60`, `= { a: 1 }`.
          const from = j + 1;
          let depth = 0;
          for (j = from; j < tokens.length; j++) {
            if (is(j, tt.parenL) || is(j, tt.bracketL) || is(j, tt.braceL) || is(j, tt.dollarBraceL)) depth++;
            else if (is(j, tt.parenR) || is(j, tt.bracketR) || is(j, tt.braceR)) {
              if (depth === 0) break;
              depth--;
            } else if (is(j, tt.comma) && depth === 0) break;
          }
          const written = source.slice(tokens[from]?.start ?? 0, tokens[j - 1]?.end ?? 0).trim();
          initial = /^-?\d+(\.\d+)?$|^(true|false)$|^'[^']*'$|^"[^"]*"$/.test(written) ? written : null;
        }
        params.push({ name: param, doc, type, initial, at });
        if (is(j, tt.comma)) j++;
      }
      j++;
      let returns: TypeNode | null = null;
      if (is(j, tt.colon)) [returns] = typeAt(j + 1);

      if (isAsync) {
        const kept = params.findIndex((param) => param.type.kind === 'name' && param.type.name === 'Kept');
        if (params.some((param, at) => at !== kept && param.type.kind === 'name' && param.type.name === 'Kept')) throw new Unreadable('A step remembers in one Kept<…>', params.at(-1)!.at);
        const inputs: ConfigSchema['fields'] = {};
        for (const param of params) {
          if (param === params[kept]) continue;
          if (!NAME.test(param.name)) throw new Unreadable(`"${param.name}": a name is a word in camelCase, as "after"`, param.at);
          inputs[param.name] = fieldOf(param.type, param.doc, param.name, param.initial);
        }
        const keptType = kept === -1 ? null : (params[kept]!.type as Extract<TypeNode, { kind: 'name' }>).args[0];
        if (kept !== -1 && !keptType) throw new Unreadable('Say what it remembers: Kept<{ times: number }>', params[kept]!.at);
        steps[name] = { about, inputs: { fields: inputs }, answer: answerOf(returns, true), memory: keptType ? memoryOf(keptType) : { fields: {} } };
        calls[name] = { params: params.map((param) => param.name), memory: kept === -1 ? null : kept };
      } else {
        if (!returns) throw new Unreadable(`Say what ${name} gives: "function ${name}(…): number"`, nameAt);
        const answer = answerOf(returns, false);
        if (!answer) throw new Unreadable(`A function gives a value: "function ${name}(…): number"`, nameAt);
        functions[name] = { about, args: params.map((param) => fieldOf(param.type, param.doc, param.name, param.initial)), returns: answer };
        calls[name] = { params: params.map((param) => param.name), memory: null };
      }
    } catch (error) {
      if (!(error instanceof Unreadable)) throw error;
      problems.push(placed(`${name}: ${error.message}`, error.at));
    }
  }
  if (!problems.length && !Object.keys(steps).length && !Object.keys(functions).length) problems.push({ message: 'It declares nothing: export an "async function" for a step, or a "function" for a value', line: null, column: null });
  return { shape: { steps, functions }, calls, problems };
}
