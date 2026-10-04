import { WEEKDAYS } from '../clock.ts';
import { TRIGGER_ID } from '../rule.ts';
import type { FieldSpec } from './spec.ts';
import { TRIGGER_KINDS, TRIGGER_KIND_ORDER } from './triggers.ts';

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

/** A trigger's own id, that what it does reads back as `run.trigger`. */
export const TRIGGER_ID_SCHEMA: JsonSchema = {
  type: 'string',
  pattern: TRIGGER_ID.source,
  description: 'Its id, which what it does reads back as `run.trigger == "low"`. Letters and digits, starting with a lowercase letter.',
};

/** One field, as a file writes it. */
export function fieldSchema(field: FieldSpec): JsonSchema {
  const described = { description: field.help ? `${field.label}: ${field.help}` : field.label };
  switch (field.type.type) {
    case 'condition':
    case 'timeOfDay':
      return { $ref: '#/$defs/expression', ...described };
    case 'duration':
      return { $ref: '#/$defs/duration', ...described };
    case 'days':
      return DAYS_SCHEMA;
    case 'role':
    case 'event':
      return { type: 'string', minLength: 1, ...described };
  }
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
        properties: { id: TRIGGER_ID_SCHEMA, ...Object.fromEntries(spec.fields.map((field) => [field.key, fieldSchema(field)])) },
      };
    }),
  };
}
