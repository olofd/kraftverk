/**
 * A deliberately small config-schema language.
 *
 * Every device type describes its settings with this, and the app renders a
 * form from it with no code of the type's own. Keeping the vocabulary tiny is the
 * whole point: an iOS build cannot download and run arbitrary UI, so the set of
 * things a form can contain has to be closed and known in advance.
 *
 * It is a subset of JSON Schema in spirit, not a JSON Schema implementation.
 * A field is a value of the one value system (`values.ts`) with a title, a
 * description and a default — plus two ways of showing a string: a secret, and
 * a host.
 */

import { checkValue, type BooleanValue, type EnumValue, type NumberValue, type StringValue, type ValueType } from './values.ts';

type Presented = { title: string; description?: string; required?: boolean };

export type ConfigField =
  | (StringValue & Presented & { default?: string; placeholder?: string })
  /** Write-only. Never returned by the API, never in an export. */
  | { type: 'secret'; title: string; description?: string; required?: boolean }
  /** An IP address or hostname on the local network. */
  | { type: 'host'; title: string; description?: string; required?: boolean; default?: string }
  | (NumberValue & Presented & { default?: number })
  | (BooleanValue & Presented & { default?: boolean })
  | (EnumValue & Presented & { default?: string });

/** The value a field holds: a secret and a host are strings, shown their own way. */
export const valueTypeOf = (field: ConfigField): ValueType =>
  field.type === 'secret' || field.type === 'host' ? { type: 'string' } : field;

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

export const isSecretField = (field: ConfigField): boolean => field.type === 'secret';

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
      else if ('required' in field && field.required) {
        issues.push({ field: name, message: `${field.title} is required` });
      }
      continue;
    }

    switch (field.type) {
      case 'host': {
        if (typeof given !== 'string') {
          issues.push({ field: name, message: `${field.title} must be text` });
          break;
        }
        // Deliberately permissive: hostnames, mDNS names and IPv4 all pass, and
        // anything with a scheme or a path does not — that is the mistake worth
        // catching here, not exotic address formats.
        if (/^[a-z0-9._-]+$/i.test(given)) value[name] = given;
        else issues.push({ field: name, message: `${field.title} must be a hostname or IP address` });
        break;
      }

      default: {
        const checked = checkValue(valueTypeOf(field), given);
        if (checked.ok) value[name] = checked.value;
        else issues.push({ field: name, message: `${field.title} ${checked.problem}` });
      }
    }
  }

  const unknown = Object.keys(raw).filter((name) => !(name in schema.fields));
  for (const name of unknown) issues.push({ field: name, message: `Unknown setting "${name}"` });

  return issues.length ? { ok: false, issues } : { ok: true, value };
}
