import { UNITS, type Dimension } from '@kraftverk/device-sdk';

import { secondsText } from '../describe.ts';
import { BUILTIN_ORDER, BUILTINS } from './builtins.ts';
import { EXPR_KIND_ORDER, EXPR_KINDS } from './exprs.ts';
import { ACROSS_FNS, ACROSS_ORDER } from './across.ts';
import { HISTORY_FNS, HISTORY_ORDER, HISTORY_SECONDS } from './history.ts';
import { RULE_PART_DOCS } from './parts.ts';
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

/** A number to show each quantity's units with, in an example. */
const UNIT_EXAMPLE: Readonly<Record<Dimension, string>> = { power: '50', energy: '1.5', current: '6', voltage: '230', frequency: '50', time: '2', ratio: '20', temperature: '21', length: '12', speed: '25', irradiance: '800', signal: '-60', illuminance: '300', angle: '59.3', 'price.EUR': '0.25', 'price.SEK': '1.5', 'price.NOK': '1.5', 'price.DKK': '1.5' };

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
    case 'months':
      return 'a list of `jan` … `dec`';
    case 'dates':
      return 'a list of dates of the year, month and day: `"12-24"`, or a span `"12-01..12-24"`';
    case 'role':
      return 'a role: what fills it is under `uses`';
    case 'automation':
      return 'a role another automation fills: `{ automation: key }` under `uses`';
    case 'script':
      return 'a role one of the family’s scripts fills: `{ script: key }` under `uses`';
    case 'group':
      return 'a role several parts fill: a list of them under `uses`';
    case 'each':
      return 'a name of its own, as a role’s: what its steps call each part, in turn';
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
    case 'variable':
      return 'one of the home’s variables, by its key: under `variables` of its home';
    case 'text':
      return 'words of your own, said as written';
    case 'flag':
      return '`true` or `false`; `false` when it is not written';
    case 'args':
      return 'each argument by its name: a value, or an expression';
    case 'steps':
      return `steps${type.sure === false ? ' — none that waits for what might not come' : ''}${type.nonEmpty ? '; at least one' : ''}`;
    case 'who':
      return `who: a role a person fills, or people fill — \`{ person: key }\`, \`{ people: [keys] }\` under \`uses\`${type.anyone ? ` — or \`${type.anyone}\`, ${type.anyone === 'someone' ? 'anyone' : 'everyone'} in the family` : ''}`;
    case 'crowd':
      return 'a role people fill: `{ people: [keys] }` under `uses`';
    case 'place':
      return 'a place: `home`, the automation’s own, or a role a home, a zone or a space fills — `{ zone: key }`, `{ space: key }` under `uses`';
    case 'mode':
      return 'a mode, by its key: `home`, `away`, `vacation`, `day`, `evening`, `night`, or one of the family’s own';
    case 'choice':
      return `one of ${type.options.map((option) => `\`${option.value}\``).join(', ')}`;
    case 'message':
      return `words of your own, at most ${type.max} characters — a value in braces said as it is then: \`{station.charge}\``;
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
    'Every construct the language has, as a configuration file writes it,',
    'each with examples — and every example here is read and checked by the',
    'language’s tests. The grammar of expressions and the rules a run keeps',
    'are in [README.md](README.md).',
    '',
    '## An automation — its parts',
    '',
    'An automation in a file is its name and these, each under its key. Each',
    'example is a whole automation, but for its name.',
    '',
  ];
  for (const part of Object.values(RULE_PART_DOCS)) {
    lines.push(`### \`${part.key}\` — ${part.label}`, '', part.summary, '', ...part.examples.flatMap((example) => ['```yaml', example, '```', '']));
  }
  lines.push(
    '## What starts it — triggers',
    '',
    'Each trigger is one item under `when`, and any of them may say what it',
    'does itself (below).',
    ''
  );
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
  lines.push(
    '',
    '### Across a group',
    '',
    'Each takes something of each part of a group — `name in group:`, the name what is said of each calls it — and takes them together. Unknown while it is for a part, unless one part settles it; numbers in the first one’s unit.',
    '',
    '| Function | Written | Is |',
    '|---|---|---|'
  );
  for (const name of ACROSS_ORDER) {
    const spec = ACROSS_FNS[name];
    lines.push(`| \`${name}(x in group: …)\` — ${spec.label} | ${spec.docs.examples.map((example) => `\`${example}\``).join(' · ')} | ${spec.docs.summary} |`);
  }
  lines.push(
    '',
    '### Over the time just gone',
    '',
    `Each looks back at a reading — \`role.meaning\` — for a length of time, from ${secondsText(HISTORY_SECONDS.min)} to ${secondsText(HISTORY_SECONDS.max)}: a number or a setting. Each value counts from when it was read until the next; the answer is in the reading’s unit, unknown when nothing was kept for that time.`,
    '',
    '| Function | Written | Is |',
    '|---|---|---|'
  );
  for (const name of HISTORY_ORDER) {
    const spec = HISTORY_FNS[name];
    lines.push(`| \`${name}(reading, time)\` — ${spec.label} | ${spec.docs.examples.map((example) => `\`${example}\``).join(' · ')} | ${spec.docs.summary} |`);
  }
  lines.push(
    '',
    '### Units',
    '',
    'A number may carry one of these, written after it — `50 W`, `1.5 kWh`, `2 min`. Any other is refused where it is written. Numbers of one quantity are converted to each other as they are compared or added; a product or quotient makes the unit the two make (a power for a time is an energy).',
    '',
    '| Unit | Is | Of | Written |',
    '|---|---|---|---|'
  );
  for (const [unit, spec] of Object.entries(UNITS)) lines.push(`| \`${unit}\` | ${spec.label} | ${spec.dimension} | \`${UNIT_EXAMPLE[spec.dimension]} ${unit}\` |`);
  return `${lines.join('\n').trimEnd()}\n`;
}
