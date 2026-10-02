import { ApiError } from '@kraftverk/api-contract';
import { isSecretField, type ConfigSchema, type ConnectionMethod, type Protocol } from '@kraftverk/device-sdk';

/** The schema of everything a connection stores for a method: its own config and its protocol's credentials. */
export function connectionSchema(method: ConnectionMethod | null, protocol: Protocol | null): ConfigSchema {
  return { fields: { ...(protocol?.credentials?.schema.fields ?? {}), ...(method?.config?.fields ?? {}) } };
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
