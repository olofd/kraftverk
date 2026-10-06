import { NAMESPACED_ID, PLAIN_ID } from './names.ts';

/*
  Two kinds of package teach kraftverk what it can reach
  (docs/PLAN-INTEGRATIONS.md §1, §4.2):

  - An **integration** teaches it a platform — a vendor's system, a cloud, a
    standard: how things on it are reached, signed into and found, its
    accounts, gateways and services, the builder its products are made with,
    and the generic type a product nobody described falls back to. It names
    no product.
  - A **device package** teaches it one product or product family: what it
    is — its models, its layout, its pictures and screens — built on the
    integration it names.

  What a package says about itself here is data only: what finding its code
  needs. Everything else — each type's kind and category, where each way of
  reaching a device runs and what it needs — is the code's, read from the
  types themselves, never written twice.
*/

/** One device type a package declares, as its manifest finds it: where its code, screens and pictures are. */
export type PackageTypeEntry = {
  /** The type's id: what its entry's default export must be called. */
  readonly id: string;
  /** The module whose default export is the type: `./src/type.ts`. */
  readonly entry: string;
  /** The module whose default export is what it brings to automations, when it brings anything. */
  readonly automation?: string;
  /** The module whose default export is its screens, when it has screens. */
  readonly ui?: string;
  /** Pictures of it as it looks, in order: the first is shown unless its owner picks another. */
  readonly images?: readonly string[];
};

/** The `kraftverk.integration` section of an integration's package.json. */
export type IntegrationManifest = {
  /** Its id, and the namespace of its own types: `acme.account` is Acme's. */
  readonly id: string;
  /** How people call the platform: "Acme Cloud". */
  readonly name: string;
  /** The platform's own types — accounts, gateways, services, the generic one. There may be none. */
  readonly types: readonly PackageTypeEntry[];
};

/** The `kraftverk.device` section of a device package's package.json. */
export type DeviceManifest = {
  /** The id of the integration it is built on: the platform it is reached through. */
  readonly integration: string;
  /** The products it describes. At least one. */
  readonly types: readonly PackageTypeEntry[];
};

/** What a hub knows of an installed integration. */
export type IntegrationInfo = {
  readonly id: string;
  readonly name: string;
};

/** Where an installed type came from: the platform it is on, and whether it is a product on it or the platform's own. */
export type TypeSource = {
  readonly integration: IntegrationInfo;
  /** A product, from a device package; false for the platform's own — an account, a gateway, a service, the generic type. */
  readonly product: boolean;
};

/** Whether a type's id is in an integration's own namespace: `acme.plug` is Acme's, `acmeplug.x` is not. */
export const inNamespace = (typeId: string, integrationId: string): boolean => typeId.startsWith(`${integrationId}.`);

/** Why a type cannot come from where it says it does, or null when it can: the platform's own types are in its namespace. */
export function sourceProblem(typeId: string, source: TypeSource): string | null {
  if (source.product || inNamespace(typeId, source.integration.id)) return null;
  return `type "${typeId}" is the platform's own, so its id must begin with "${source.integration.id}."`;
}

const isPath = (value: unknown): value is string => typeof value === 'string' && value.startsWith('./') && !value.includes('..');

/** A path in the package, or another package's export by name (`@kraftverk/integration-acme/ui`): a product may use its platform's screens. */
const isModule = (value: unknown): value is string => isPath(value) || (typeof value === 'string' && /^@kraftverk\/[a-z0-9-]+(\/[a-z0-9./-]+)?$/.test(value));

function typeEntryProblems(raw: unknown, problems: string[], namespace: string | null): void {
  if (!Array.isArray(raw)) {
    problems.push('types must be a list');
    return;
  }
  const seen = new Set<string>();
  raw.forEach((rawEntry: unknown, index) => {
    const entry = (rawEntry ?? {}) as Record<string, unknown>;
    const where = `types[${index}]`;
    const typeId = entry.id;
    if (typeof typeId !== 'string' || !NAMESPACED_ID.test(typeId)) {
      problems.push(`${where}: id "${String(typeId)}" must be namespaced lowercase, like "brand.model"`);
    } else {
      if (namespace !== null && !inNamespace(typeId, namespace)) problems.push(`${where}: "${typeId}" is the platform's own, so it must begin with "${namespace}."`);
      if (seen.has(typeId)) problems.push(`${where}: "${typeId}" is listed twice`);
      seen.add(typeId);
    }
    if (!isPath(entry.entry)) problems.push(`${where}: entry must be a path in the package, like "./src/type.ts"`);
    if (entry.automation !== undefined && !isPath(entry.automation)) problems.push(`${where}: automation must be a path in the package`);
    if (entry.ui !== undefined && !isModule(entry.ui)) problems.push(`${where}: ui must be a path in the package, or a package's export by name`);
    if (entry.images !== undefined && (!Array.isArray(entry.images) || !entry.images.every(isPath))) problems.push(`${where}: images must be paths in the package`);
  });
}

/** Everything wrong with an integration's manifest, read from its package.json as it is. Empty: the code can be found by it. */
export function integrationManifestProblems(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object') return ['the integration section must be an object'];
  const manifest = raw as Record<string, unknown>;
  const problems: string[] = [];
  const id = manifest.id;
  const valid = typeof id === 'string' && PLAIN_ID.test(id);
  if (!valid) problems.push(`id "${String(id)}" must be lowercase words joined by dashes, like "acme-cloud"`);
  if (typeof manifest.name !== 'string' || !manifest.name.trim()) problems.push('name is required');
  typeEntryProblems(manifest.types, problems, valid ? (id as string) : null);
  return problems;
}

/** Everything wrong with a device package's manifest, read from its package.json as it is. */
export function deviceManifestProblems(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object') return ['the device section must be an object'];
  const manifest = raw as Record<string, unknown>;
  const problems: string[] = [];
  if (typeof manifest.integration !== 'string' || !PLAIN_ID.test(manifest.integration)) problems.push('integration must name the integration it is built on, like "acme"');
  if (!Array.isArray(manifest.types) || !manifest.types.length) problems.push('types must list at least one product');
  else typeEntryProblems(manifest.types, problems, null);
  return problems;
}
