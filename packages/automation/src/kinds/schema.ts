import { CAMEL_NAME, MODE_KEY, type ConfigField } from '@kraftverk/device-sdk';

import { WEEKDAYS } from '../clock.ts';
import { TRIGGER_ID } from '../rule.ts';
import type { ScriptShape } from '../script.ts';
import { durationText } from '../text/rules.ts';
import type { FieldSpec } from './spec.ts';
import { STEP_KIND_ORDER, STEP_KINDS, type StepSpec } from './steps.ts';
import { TRIGGER_FIELDS, TRIGGER_KINDS, TRIGGER_KIND_ORDER } from './triggers.ts';

/*
  The JSON Schema of the language's constructs, made from their descriptions:
  what an editor that knows JSON Schema completes and checks as a file is
  typed. It refers to two pieces the document's own schema defines —
  `#/$defs/expression` and `#/$defs/duration` — so one schema holds the whole
  configuration file.
*/

export type JsonSchema = Record<string, unknown>;

/** Days as a file writes them: weekdays, weekends, or the list. */
export const DAYS_SCHEMA: JsonSchema = {
  anyOf: [{ enum: ['weekdays', 'weekends'] }, { type: 'array', items: { enum: [...WEEKDAYS] }, minItems: 1, uniqueItems: true }],
  description: 'weekdays, weekends, or a list of mon … sun',
};

/** One field, as a file writes it. */
export function fieldSchema(field: FieldSpec): JsonSchema {
  const described = { description: field.help ? `${field.label}: ${field.help}` : field.label };
  switch (field.type.type) {
    case 'condition':
    case 'value':
    case 'timeOfDay':
    case 'count':
      return { $ref: '#/$defs/expression', ...described };
    case 'duration':
      return { $ref: '#/$defs/duration', ...described };
    case 'days':
      return DAYS_SCHEMA;
    case 'role':
    case 'automation':
    case 'script':
    case 'group':
    case 'event':
    case 'name':
      return { type: 'string', minLength: 1, ...described };
    case 'each':
      return { type: 'string', pattern: CAMEL_NAME.source, ...described };
    case 'id':
      return { type: 'string', pattern: TRIGGER_ID.source, ...described };
    case 'memory':
    case 'text':
      return { type: 'string', minLength: 1, ...described };
    case 'flag':
      return { type: 'boolean', ...described };
    case 'steps':
      return { type: 'array', items: { $ref: '#/$defs/step' }, ...described };
    case 'args':
      return { type: 'object', additionalProperties: { $ref: '#/$defs/expression' }, ...described };
    case 'who':
    case 'crowd':
    case 'place':
      return { type: 'string', minLength: 1, ...described };
    case 'mode':
      return { type: 'string', pattern: MODE_KEY.source, ...described };
    case 'choice':
      return { enum: field.type.options.map((option) => option.value), ...described };
    case 'message':
      return { type: 'string', minLength: 1, maxLength: field.type.max, ...described };
  }
}

/** A script's step as a file names it: by its key and the step's name — or its key alone, when it has only that step. */
type ScriptOffered = { key: string; name: string; shape: ScriptShape | null };

/** A value a script's step is given, as a file writes it: an expression, offered at its default, said with its title, unit and limits. */
function inputSchema(field: ConfigField): JsonSchema {
  const amount = (value: number) => (field.type === 'number' && field.unit === 's' ? durationText(value) : `${value}${field.type === 'number' && field.unit ? ` ${field.unit}` : ''}`);
  const said =
    field.type === 'number'
      ? [field.unit === 's' ? 'a length of time' : field.unit ? `in ${field.unit}` : 'a number', field.min !== undefined ? `from ${amount(field.min)}` : null, field.max !== undefined ? `to ${amount(field.max)}` : null].filter(Boolean).join(', ')
      : field.type === 'boolean'
        ? 'true or false'
        : field.type === 'enum'
          ? field.options.map((option) => option.value).join(', ')
          : field.type === 'timestamp'
            ? 'a date and time'
            : 'words';
  const fallback = field.default === undefined ? undefined : typeof field.default === 'number' ? amount(field.default) : field.default;
  return {
    title: field.title,
    description: `${field.title}: ${said}${fallback !== undefined ? `. Not given: ${String(fallback)}` : ''}`,
    ...(field.type === 'enum' ? { enum: field.options.map((option) => option.value) } : { $ref: '#/$defs/expression' }),
    ...(fallback !== undefined ? { default: fallback } : {}),
  };
}

/**
 * Each step of each of the family's scripts, as a "run script" step of its
 * own: `run script` its `key.step` (or its key, when it has one step), and
 * under `with` exactly that step's inputs — what an editor completes as a
 * script is named.
 */
function scriptStepSchemas(scripts: readonly ScriptOffered[]): JsonSchema[] {
  return scripts.flatMap((script) => {
    const steps = Object.entries(script.shape?.steps ?? {});
    return steps.map(([step, shape]) => ({
      title: `Run ${script.name}: ${step}`,
      description: shape.about ?? `A step of the script ${script.name}.`,
      type: 'object',
      required: ['run script'],
      additionalProperties: false,
      properties: {
        'run script': { enum: [`${script.key}.${step}`, ...(steps.length === 1 ? [script.key] : [])], description: `${script.name}, its step ${step}${shape.about ? `: ${shape.about}` : ''}` },
        ...(Object.keys(shape.inputs.fields).length
          ? // Open — to a name it does not take, and to nothing yet: the automation's check says what is wrong — so a "with" empty or half typed still finds this step, and its inputs are offered.
            { with: { properties: Object.fromEntries(Object.entries(shape.inputs.fields).map(([input, field]) => [input, inputSchema(field)])), description: 'What it is given, each by its name: the rest their defaults.' } }
          : {}),
        ...(shape.answer ? { 'remember as': { type: 'string', minLength: 1, description: 'Remember what it answers as: one of what this automation remembers.' } } : {}),
      },
    }));
  });
}

/**
 * Every kind of step: one object a form — each kind's fields under its verb,
 * or its own words' forms; and, given the family's scripts, each of their
 * steps as one of its own.
 */
export function stepJsonSchema(scripts: readonly ScriptOffered[] = []): JsonSchema {
  return {
    anyOf: STEP_KIND_ORDER.flatMap((kind) => {
      const spec = STEP_KINDS[kind] as unknown as StepSpec;
      if (spec.text) return spec.text.schema().map((form) => ({ description: spec.docs.summary, ...form }));
      // The plain form names a role — or a script by its key: every one offered, as a part is where a role is filled.
      const named = scripts.flatMap((script) => {
        const steps = Object.keys(script.shape?.steps ?? {});
        return [...steps.map((step) => `${script.key}.${step}`), ...(steps.length === 1 ? [script.key] : [])];
      });
      const own = (field: (typeof spec.fields)[number]) => (kind === 'script' && field.type.type === 'script' && named.length ? { anyOf: [{ enum: named }, fieldSchema(field)] } : fieldSchema(field));
      return [
        ...(kind === 'script' ? scriptStepSchemas(scripts) : []),
        {
          title: spec.label,
          description: spec.docs.summary,
          type: 'object',
          required: spec.fields.filter((field) => field.required && field.type.type !== 'steps').map((field) => field.key),
          additionalProperties: false,
          properties: Object.fromEntries(spec.fields.map((field) => [field.key, own(field)])),
        },
      ];
    }),
  };
}

/** Every kind of trigger: one object each, with exactly its own keys. */
export function triggerJsonSchema(): JsonSchema {
  return {
    anyOf: TRIGGER_KIND_ORDER.map((kind) => {
      const spec = TRIGGER_KINDS[kind];
      return {
        title: spec.label,
        description: spec.docs.summary,
        type: 'object',
        required: spec.fields.filter((field) => field.required).map((field) => field.key),
        additionalProperties: false,
        properties: Object.fromEntries([...spec.fields, ...TRIGGER_FIELDS].map((field) => [field.key, fieldSchema(field)])),
      };
    }),
  };
}
