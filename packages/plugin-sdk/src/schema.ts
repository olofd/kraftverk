/**
 * A deliberately small config-schema language.
 *
 * Every plugin describes its settings with this, and the app renders a setup
 * form from it with no plugin-supplied code. Keeping the vocabulary tiny is the
 * whole point: an iOS build cannot download and run arbitrary UI, so the set of
 * things a form can contain has to be closed and known in advance.
 *
 * It is a subset of JSON Schema in spirit, not a JSON Schema implementation.
 */

export type ConfigField =
  | { type: 'string'; title: string; description?: string; required?: boolean; default?: string; placeholder?: string }
  /** Write-only. Never returned by the API, never in an export. */
  | { type: 'secret'; title: string; description?: string; required?: boolean }
  /** An IP address or hostname on the local network. */
  | { type: 'host'; title: string; description?: string; required?: boolean; default?: string }
  | {
      type: 'number';
      title: string;
      description?: string;
      required?: boolean;
      default?: number;
      min?: number;
      max?: number;
      step?: number;
      unit?: string;
      integer?: boolean;
    }
  | { type: 'boolean'; title: string; description?: string; default?: boolean }
  | {
      type: 'enum';
      title: string;
      description?: string;
      required?: boolean;
      default?: string;
      options: readonly { value: string; label: string }[];
    };

export type ConfigSchema = {
  fields: Record<string, ConfigField>;
  /** Rendered as a section note above the form. */
  help?: string;
};

export type ConfigValues = Record<string, string | number | boolean | undefined>;

export type ValidationIssue = { field: string; message: string };

export type ValidationResult =
  | { ok: true; value: ConfigValues }
  | { ok: false; issues: ValidationIssue[] };

export const isSecretField = (field: ConfigField): boolean => field.type === 'secret';

/** The fields a plugin keeps in the secret store rather than in config. */
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
      case 'string':
      case 'secret':
        if (typeof given !== 'string') issues.push({ field: name, message: `${field.title} must be text` });
        else value[name] = given;
        break;

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

      case 'number': {
        const numeric = typeof given === 'number' ? given : Number(given);
        if (!Number.isFinite(numeric)) {
          issues.push({ field: name, message: `${field.title} must be a number` });
          break;
        }
        if (field.integer && !Number.isInteger(numeric)) {
          issues.push({ field: name, message: `${field.title} must be a whole number` });
          break;
        }
        if (field.min !== undefined && numeric < field.min) {
          issues.push({ field: name, message: `${field.title} must be at least ${field.min}` });
          break;
        }
        if (field.max !== undefined && numeric > field.max) {
          issues.push({ field: name, message: `${field.title} must be at most ${field.max}` });
          break;
        }
        value[name] = numeric;
        break;
      }

      case 'boolean':
        if (typeof given !== 'boolean') issues.push({ field: name, message: `${field.title} must be true or false` });
        else value[name] = given;
        break;

      case 'enum': {
        const allowed = field.options.map((option) => option.value);
        if (typeof given !== 'string' || !allowed.includes(given)) {
          issues.push({ field: name, message: `${field.title} must be one of: ${allowed.join(', ')}` });
          break;
        }
        value[name] = given;
        break;
      }
    }
  }

  const unknown = Object.keys(raw).filter((name) => !(name in schema.fields));
  for (const name of unknown) issues.push({ field: name, message: `Unknown setting "${name}"` });

  return issues.length ? { ok: false, issues } : { ok: true, value };
}
