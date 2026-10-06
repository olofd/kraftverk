/**
 * A deliberately small config-schema language.
 *
 * Every device type describes its settings with this, and the app renders a
 * form from it with no code of the type's own. Keeping the vocabulary tiny is the
 * whole point: an iOS build cannot download and run arbitrary UI, so the set of
 * things a form can contain has to be closed and known in advance.
 *
 * It is a subset of JSON Schema in spirit, not a JSON Schema implementation.
 * A field is a value of the one value system (`values.ts`) — one of its
 * scalars — with a title, a description, a default and how to present it:
 * text as a secret, a host or several lines; a number as a slider. There is
 * no other type system: a secret is text, shown and kept its own way.
 */

import { checkValue, type BooleanValue, type EnumValue, type NumberValue, type ScalarValueType, type StringValue, type TimestampValue } from './values.ts';

/**
 * How a field is shown and kept, beyond its type.
 *
 * - `secret` — text that is written, never read back: not returned by the
 *   API, not in an export, kept as a connection's secret.
 * - `host` — text that is an IP address or a host name on the local network.
 * - `multiline` — text that runs to several lines.
 * - `slider` — a number with a range, dragged rather than typed.
 */
export type Presentation = 'secret' | 'host' | 'multiline' | 'slider';

type Presented = { title: string; description?: string; required?: boolean };

export type ConfigField =
  | (StringValue &
      Presented & {
        default?: string;
        placeholder?: string;
        presentation?: 'secret' | 'host' | 'multiline';
        /**
         * A secret its session keeps, not one a person gives — a sign-in
         * token, renewed as it runs: never asked for, written by the session
         * through its connection, and kept sealed with the rest, in the file
         * too, so a restart does not sign in again.
         */
        kept?: 'session';
      })
  | (NumberValue & Presented & { default?: number; presentation?: 'slider' })
  | (BooleanValue & Presented & { default?: boolean })
  | (EnumValue & Presented & { default?: string })
  | (TimestampValue & Presented & { default?: string });

/** The value a field holds, without how it is presented. */
export const valueTypeOf = (field: ConfigField): ScalarValueType => {
  switch (field.type) {
    case 'string':
      return { type: 'string' };
    case 'number': {
      const { title: _title, description: _description, required: _required, default: _default, presentation: _presentation, ...type } = field;
      return type;
    }
    case 'boolean':
      return { type: 'boolean' };
    case 'enum':
      return { type: 'enum', options: field.options };
    case 'timestamp':
      return { type: 'timestamp' };
  }
};

export const presentationOf = (field: ConfigField): Presentation | null => ('presentation' in field ? (field.presentation ?? null) : null);

export type ConfigSchema = {
  fields: Record<string, ConfigField>;
  /** Rendered as a section note above the form. */
  help?: string;
};

export type ConfigValues = Record<string, string | number | boolean | undefined>;

/** The defaults a schema gives, for describing a device before any is saved. */
export const configDefaults = (schema: ConfigSchema): ConfigValues =>
  Object.fromEntries(Object.entries(schema.fields).flatMap(([name, field]) => ('default' in field && field.default !== undefined ? [[name, field.default]] : [])));

export type ValidationIssue = { field: string; message: string };

export type ValidationResult =
  | { ok: true; value: ConfigValues }
  | { ok: false; issues: ValidationIssue[] };

export const isSecretField = (field: ConfigField): boolean => presentationOf(field) === 'secret';

/** Whether a field is a secret its session keeps, not one a person gives. */
export const isSessionKept = (field: ConfigField): boolean => isSecretField(field) && 'kept' in field && field.kept === 'session';

/** A schema with only what a person gives: the secrets a session keeps left out. What a setup form asks. */
export const personFields = (schema: ConfigSchema): ConfigSchema => ({ ...schema, fields: Object.fromEntries(Object.entries(schema.fields).filter(([, field]) => !isSessionKept(field))) });

/** The fields kept as connection secrets rather than in config. */
export function secretFields(schema: ConfigSchema): string[] {
  return Object.entries(schema.fields)
    .filter(([, field]) => isSecretField(field))
    .map(([name]) => name);
}

/** Config with every secret removed — for the API, and for config export. */
export function withoutSecrets(schema: ConfigSchema, values: ConfigValues): ConfigValues {
  const secrets = new Set(secretFields(schema));
  return Object.fromEntries(Object.entries(values).filter(([name]) => !secrets.has(name)));
}

/** Every problem with a schema as declared: a presentation its type cannot have, a default that does not fit. */
export function schemaProblems(where: string, schema: ConfigSchema | undefined): string[] {
  const problems: string[] = [];
  for (const [name, field] of Object.entries(schema?.fields ?? {})) {
    const presentation = presentationOf(field);
    const fits = presentation === null || (field.type === 'string' ? ['secret', 'host', 'multiline'].includes(presentation) : field.type === 'number' && presentation === 'slider');
    if (!fits) problems.push(`${where} field "${name}" is ${field.type}, which cannot be presented as ${presentation}`);
    if (presentation === 'slider' && field.type === 'number' && (field.min === undefined || field.max === undefined)) problems.push(`${where} field "${name}" is a slider with no range`);
    if (!field.title?.trim()) problems.push(`${where} field "${name}" has no title`);
    if ('default' in field && field.default !== undefined && !checkValue(valueTypeOf(field), field.default).ok) problems.push(`${where} field "${name}" has a default its type does not allow`);
  }
  return problems;
}

/**
 * Checks values against a schema, applying defaults.
 *
 * Returns every problem at once rather than the first: a setup form should
 * light up all its bad fields, not make you resubmit to find the next one.
 */
export function validateConfig(schema: ConfigSchema, input: unknown): ValidationResult {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, issues: [{ field: '', message: 'Expected an object of settings' }] };
  }

  const raw = input as Record<string, unknown>;
  const issues: ValidationIssue[] = [];
  const value: ConfigValues = {};

  for (const [name, field] of Object.entries(schema.fields)) {
    const given = raw[name];
    const missing = given === undefined || given === null || given === '';

    if (missing) {
      if ('default' in field && field.default !== undefined) value[name] = field.default;
      else if (field.type === 'boolean') value[name] = false;
      else if (field.required) issues.push({ field: name, message: `${field.title} is required` });
      continue;
    }

    const checked = checkValue(valueTypeOf(field), given);
    if (!checked.ok) {
      issues.push({ field: name, message: `${field.title} ${checked.problem}` });
      continue;
    }
    // Deliberately permissive: host names, mDNS names and IPv4 all pass, and
    // anything with a scheme or a path does not — that is the mistake worth
    // catching here, not exotic address formats.
    if (presentationOf(field) === 'host' && !/^[a-z0-9._-]+$/i.test(String(checked.value))) {
      issues.push({ field: name, message: `${field.title} must be a hostname or IP address` });
      continue;
    }
    value[name] = checked.value as string | number | boolean;
  }

  const unknown = Object.keys(raw).filter((name) => !(name in schema.fields));
  for (const name of unknown) issues.push({ field: name, message: `Unknown setting "${name}"` });

  return issues.length ? { ok: false, issues } : { ok: true, value };
}
