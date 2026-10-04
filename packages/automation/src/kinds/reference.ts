import { secondsText } from '../describe.ts';
import type { FieldSpec } from './spec.ts';
import { TRIGGER_KIND_ORDER, TRIGGER_KINDS } from './triggers.ts';

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
      return 'a condition: `station.battery.soc < 15 %`';
    case 'timeOfDay':
      return 'a time of day, `"HH:MM"`, on the automation’s clock';
    case 'duration':
      return `a length of time, \`2 min\` — ${secondsText(type.min)} to ${secondsText(type.max)}${type.step ? `, in steps of ${secondsText(type.step)}` : ''}`;
    case 'days':
      return '`weekdays`, `weekends`, or a list of `mon` … `sun`';
    case 'role':
      return 'a role: what fills it is under `uses`';
    case 'event': {
      const from = fields.find((each) => each.key === type.role);
      return `an event the part filling \`${from?.key ?? type.role}\` declares: \`mains.lost\``;
    }
  }
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
    'Each trigger is one item under `when`. Any of them may carry an `id`',
    '(`id: low`), which what the automation does reads back as',
    '`run.trigger == "low"`.',
    '',
  ];
  for (const kind of TRIGGER_KIND_ORDER) {
    const spec = TRIGGER_KINDS[kind];
    lines.push(`### \`${kind}\` — ${spec.label}`, '', spec.docs.summary, '', '| Word | Holds | |', '|---|---|---|');
    for (const field of spec.fields) lines.push(`| \`${field.key}\` | ${holds(field, spec.fields)} | ${field.required ? 'needed' : 'if you like'} |`);
    lines.push('');
    for (const example of spec.docs.examples) lines.push('```yaml', 'when:', ...example.split('\n').map((line, index) => `${index === 0 ? '  - ' : '    '}${line}`), '```', '');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}
