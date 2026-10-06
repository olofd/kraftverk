import { ApiError } from '@kraftverk/api-contract';
import { isBridged, isSecretField, type ConfigField, type ConfigSchema, type ConnectionMethod, type Protocol } from '@kraftverk/device-sdk';

/**
 * The schema of everything a connection stores for a method: its own config
 * and its protocol's credentials — but for a way through a bridge, whose
 * sign-in is the bridge's: it carries none of its own.
 */
export function connectionSchema(method: ConnectionMethod | null, protocol: Protocol | null): ConfigSchema {
  const credentials = method && isBridged(method) ? {} : (protocol?.credentials?.schema.fields ?? {});
  return { fields: { ...credentials, ...(method?.config?.fields ?? {}) } };
}

/** The fields of a connection that are secrets, each with its spec, as its method and protocol declare them: what setup asks for, an export seals and an import carries. */
export function secretFieldsOf(method: ConnectionMethod | null, protocol: Protocol | null): [string, ConfigField][] {
  return Object.entries(connectionSchema(method, protocol).fields).filter(([, spec]) => isSecretField(spec));
}

/**
 * Refuses what is not one of a connection's secrets, as its method and
 * protocol declare them: whoever holds the connection — the master, or a
 * node following it — sets its secrets by this one rule.
 */
export function checkSecretFields(method: ConnectionMethod | null, protocol: Protocol | null, given: Readonly<Record<string, string>>): void {
  const { fields } = connectionSchema(method, protocol);
  const refused = Object.keys(given).filter((field) => !fields[field] || !isSecretField(fields[field]!));
  if (refused.length) throw new ApiError('invalid', `Not a secret of this connection: ${refused.join(', ')}`);
}
