import {
  isBridgedMethod,
  isSecretField,
  LINK_KIND_IDS,
  methodsOf,
  partsOf,
  POLICY_VALUES,
  type ConfigSchema,
  type ProtocolDeclaration,
  type TypeEntry,
} from '@kraftverk/device-sdk';

/*
  What a configuration may name (docs/CONFIG.md): the installed device types,
  each with its settings and the ways it is reached — each way's settings and
  secrets — the kinds of link, the home's policy values, and the keys the
  server already knows. Plain data: the JSON Schema an editor checks against
  and the check that reads a document's meaning are both made from it, on
  the server and in the app alike.
*/

export type VocabularyMethod = {
  id: string;
  label: string;
  /** Its address when the method has one of its own (a web service's); the file then names none. */
  fixedAddress: string | null;
  /** The method's own settings and its protocol's non-secret credentials. */
  settings: ConfigSchema;
  /** Its protocol's secret credentials. */
  secrets: ConfigSchema;
  /** The bridge types it goes through, for a way through one: the device it names under `through` is one. Empty otherwise. */
  through: string[];
};

export type VocabularyType = { id: string; name: string; settings: ConfigSchema; methods: VocabularyMethod[]; parts: string[] };

export type Vocabulary = {
  types: VocabularyType[];
  linkKinds: string[];
  policy: Record<string, { label: string; min: number; max: number; unit: string }>;
  /** The devices the server has now, by key: what a file may name without carrying. */
  devices: { key: string; type: string; name: string; parts: string[] }[];
  /** The automations the server has now, by key. */
  automations: { key: string; name: string }[];
};

const split = (schema: ConfigSchema | undefined, secret: boolean): ConfigSchema => ({
  fields: Object.fromEntries(Object.entries(schema?.fields ?? {}).filter(([, field]) => isSecretField(field) === secret)),
});

/**
 * The vocabulary from what is installed: each type and its methods, each
 * method's protocol's credentials split into settings and secrets — and what
 * the server has, when it is given.
 */
export function vocabularyOf(
  types: readonly TypeEntry[],
  protocol: (id: string) => Pick<ProtocolDeclaration, 'credentials'> | null,
  have: { devices?: Vocabulary['devices']; automations?: Vocabulary['automations'] } = {}
): Vocabulary {
  return {
    types: types.map((type) => ({
      id: type.id,
      name: type.meta.name,
      settings: type.config ?? { fields: {} },
      parts: partsOf(type.description).map((part) => part.id),
      methods: methodsOf(type).map((method) => {
        // A way through a bridge signs in as the bridge does: it carries no credentials of its own.
        const credentials = isBridgedMethod(method) ? undefined : protocol(method.protocol)?.credentials?.schema;
        return {
          id: method.id,
          label: method.label,
          fixedAddress: method.address ?? null,
          settings: { fields: { ...split(credentials, false).fields, ...(method.config?.fields ?? {}) } },
          secrets: split(credentials, true),
          through: [...(method.through ?? [])],
        };
      }),
    })),
    linkKinds: [...LINK_KIND_IDS],
    policy: Object.fromEntries(Object.entries(POLICY_VALUES).map(([name, spec]) => [name, { label: spec.label, min: spec.min, max: spec.max, unit: spec.unit }])),
    devices: have.devices ?? [],
    automations: have.automations ?? [],
  };
}
