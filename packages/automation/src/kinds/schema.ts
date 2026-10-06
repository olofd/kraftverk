import { CAMEL_NAME } from '@kraftverk/device-sdk';

import { WEEKDAYS } from '../clock.ts';
import { TRIGGER_ID } from '../rule.ts';
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
  }
}

/** Every kind of step: one object a form — each kind's fields under its verb, or its own words' forms. */
export function stepJsonSchema(): JsonSchema {
  return {
    anyOf: STEP_KIND_ORDER.flatMap((kind) => {
      const spec = STEP_KINDS[kind] as unknown as StepSpec;
      if (spec.text) return spec.text.schema().map((form) => ({ description: spec.docs.summary, ...form }));
      return [
        {
          title: spec.label,
          description: spec.docs.summary,
          type: 'object',
          required: spec.fields.filter((field) => field.required && field.type.type !== 'steps').map((field) => field.key),
          additionalProperties: false,
          properties: Object.fromEntries(spec.fields.map((field) => [field.key, fieldSchema(field)])),
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
