import { secondsText } from '../describe.ts';
import { BUILTIN_ORDER, BUILTINS } from './builtins.ts';
import { EXPR_KIND_ORDER, EXPR_KINDS } from './exprs.ts';
import type { FieldSpec } from './spec.ts';
import { STEP_KIND_ORDER, STEP_KINDS, type StepSpec } from './steps.ts';
import { TRIGGER_FIELDS, TRIGGER_FIELDS_DOCS, TRIGGER_KIND_ORDER, TRIGGER_KINDS } from './triggers.ts';

/*
  The language's reference, made from its own description (REFERENCE.md):
  every construct, what it is for, each of its words and what each holds, and
  examples a file can copy — written from the registry, so it cannot fall
  behind it. `npm run gen:reference` writes it; the architecture check says
  when it is not current.
*/

/** What a field holds, as the reference says it. */
function holds(field: FieldSpec, fields: readonly FieldSpec[]): string {
  const type = field.type;
  switch (type.type) {
    case 'condition':
      return `a condition: \`station.charge < 15 %\`${type.calls ? ', which may ask a package' : ''}`;
    case 'value':
      return 'a value, or an expression for one';
    case 'timeOfDay':
      return 'a time of day, `"HH:MM"`, on the automation’s clock';
    case 'duration':
      return `a length of time, \`2 min\` — ${secondsText(type.min)} to ${secondsText(type.max)}${type.step ? `, in steps of ${secondsText(type.step)}` : ''}${type.fixed ? '; a number or a setting, never a reading' : ''}`;
    case 'count':
      return `how many times, 1 to ${type.max}; a number or a setting`;
    case 'days':
      return '`weekdays`, `weekends`, or a list of `mon` … `sun`';
    case 'role':
      return 'a role: what fills it is under `uses`';
    case 'automation':
      return 'a role another automation fills: `{ automation: key }` under `uses`';
    case 'event': {
      const from = fields.find((each) => each.key === type.role);
      return `an event the part filling \`${from?.key ?? type.role}\` declares: \`mains.lost\``;
    }
    case 'name':
      return 'a name its part declares';
    case 'id':
      return 'a name of its own, unique in the automation: letters and digits, from a lowercase letter';
    case 'memory':
      return 'one of what it remembers, by its name: under `memory`';
    case 'args':
      return 'each argument by its name: a value, or an expression';
    case 'steps':
      return `steps${type.sure === false ? ' — none that waits for what might not come' : ''}${type.nonEmpty ? '; at least one' : ''}`;
  }
}

/** A kind's page: its summary, its words and what each holds, and examples as a file writes them, under `under`. */
function kindPage(heading: string, summary: string, fields: readonly FieldSpec[], examples: readonly string[], under: string): string[] {
  const lines = [heading, '', summary, '', '| Word | Holds | |', '|---|---|---|'];
  for (const field of fields) lines.push(`| \`${field.key}\` | ${holds(field, fields)} | ${field.required ? 'needed' : 'if you like'} |`);
  lines.push('');
  for (const example of examples) lines.push('```yaml', `${under}:`, ...example.split('\n').map((line, index) => `${index === 0 ? '  - ' : '    '}${line}`), '```', '');
  return lines;
}

/** The reference, as Markdown. */
export function referenceMarkdown(): string {
  const lines: string[] = [
    '# The automation language — reference',
    '',
    '<!-- Written from the language\'s own description (packages/automation/src/kinds). Do not edit: run `npm run gen:reference`. -->',
    '',
    'Every construct the language has, as a configuration file writes it. The',
    'grammar of expressions, units and the rules a run keeps are in',
    '[README.md](README.md).',
    '',
    '## What starts it — triggers',
    '',
    'Each trigger is one item under `when`, and any of them may say what it',
    'does itself (below).',
    '',
  ];
  for (const kind of TRIGGER_KIND_ORDER) {
    const spec = TRIGGER_KINDS[kind];
    lines.push(...kindPage(`### \`${kind}\` — ${spec.label}`, spec.docs.summary, spec.fields, spec.docs.examples, 'when'));
  }
  lines.push(...kindPage('### Every trigger — what it does, and its name', TRIGGER_FIELDS_DOCS.summary, TRIGGER_FIELDS, TRIGGER_FIELDS_DOCS.examples, 'when'));
  lines.push(
    '## What it does — steps',
    '',
    'Each step is one item under `do` (and `if a step fails`), in order. A',
    'rule of commands and settings alone does everything at once; one that',
    'waits takes as long as its steps allow, and never longer: every wait has',
    'its limit, every retry its count.',
    ''
  );
  for (const kind of STEP_KIND_ORDER) {
    const spec = STEP_KINDS[kind] as unknown as StepSpec;
    const verbs = spec.text ? spec.text.verbs : [spec.fields[0]!.key];
    lines.push(...kindPage(`### ${verbs.map((verb) => `\`${verb}\``).join(', ')} — ${spec.label}`, spec.docs.summary, spec.fields, spec.docs.examples, 'do'));
  }
  lines.push(
    '## Conditions and values — expressions',
    '',
    'An expression is written as text — `station.charge < 15 %` — wherever',
    'a condition or a value goes. Unknown — a reading not given, a part not',
    'reached — is never taken for true.',
    '',
    '| Kind | Written | Is |',
    '|---|---|---|'
  );
  for (const kind of EXPR_KIND_ORDER) {
    const spec = EXPR_KINDS[kind];
    lines.push(`| ${spec.label} | ${spec.docs.examples.map((example) => `\`${example}\``).join(' · ')} | ${spec.docs.summary} |`);
  }
  lines.push(
    '',
    '### The language’s own functions',
    '',
    'Each takes numbers, each with its unit, and answers in the first one’s unit. Unknown when any argument is.',
    '',
    '| Function | Written | Is |',
    '|---|---|---|'
  );
  for (const name of BUILTIN_ORDER) {
    const spec = BUILTINS[name];
    lines.push(`| \`${name}(${spec.params.join(', ')})\` — ${spec.label} | ${spec.docs.examples.map((example) => `\`${example}\``).join(' · ')} | ${spec.docs.summary} |`);
  }
  return `${lines.join('\n').trimEnd()}\n`;
}
