import type { DeviceDescription } from './description.ts';
import { configDefaults } from './schema.ts';
import type { DeviceType } from './device-type.ts';
import type { Binding, Protocol } from './protocol.ts';
import type { SetupActionView } from './setup.ts';

/*
  The catalogue (docs/PLAN-INTEGRATIONS.md §6.1): what every installed
  integration and device package declares, as data — none of its code. A
  home lists, offers, discovers and plans by it, and imports an
  integration's code only when it needs it: a device of its types opens, a
  sighting its ways are found by needs confirming, a person starts adding
  one. Each package carries its own, generated beside its package.json
  (`npm run gen:devices`), so adding a package is still adding its folder.
*/

/** What a type declares as data: everything but its code. A loaded type is one too. */
export type TypeDeclaration = Pick<DeviceType<any>, 'id' | 'kind' | 'meta' | 'config' | 'connections' | 'simulation' | 'tools' | 'bridge'> & {
  readonly setup?: { readonly saveAnyway?: string };
};

/** A type as the catalogue keeps it: its declaration — its ways without their steps, which are code — and what a device of it is with the default config. */
export type TypeEntry = TypeDeclaration & { readonly description: DeviceDescription };

/** How a protocol rides one transport, as data. */
export type BindingDeclaration = Pick<Binding, 'instructions' | 'addressLabel'>;

/** What a protocol declares as data: its bindings by transport, and what setup asks for. A loaded protocol is one too. */
export type ProtocolDeclaration = {
  readonly id: string;
  readonly label: string;
  readonly bindings: Readonly<Record<string, BindingDeclaration>>;
  readonly credentials?: {
    readonly schema: NonNullable<Protocol['credentials']>['schema'];
    readonly actions?: readonly SetupActionView[];
    readonly first?: boolean;
    readonly title?: string;
  };
};

/** A type in a package's catalogue, and whether it is a product on its integration rather than the integration's own. */
export type CatalogueType = TypeEntry & { readonly automation: boolean };

/**
 * What one package's `catalogue.json` holds: an integration's protocols and
 * its own types, or a device package's products.
 */
export type PackageCatalogue = {
  readonly protocols: readonly ProtocolDeclaration[];
  readonly types: readonly CatalogueType[];
};

/** A type as the catalogue keeps it, from its code: what generating a catalogue writes, and what a loaded type is checked against. */
export function entryOf(type: DeviceType<any>): TypeEntry {
  return {
    id: type.id,
    kind: type.kind,
    meta: type.meta,
    config: type.config,
    // A way's own steps are code: they come with the type, when it loads.
    connections: type.connections.map(({ steps: _steps, ...method }) => method),
    ...(type.simulation ? { simulation: type.simulation } : {}),
    ...(type.tools ? { tools: type.tools } : {}),
    ...(type.bridge ? { bridge: type.bridge } : {}),
    ...(type.setup?.saveAnyway ? { setup: { saveAnyway: type.setup.saveAnyway } } : {}),
    description: type.describe(configDefaults(type.config)),
  };
}

/** A protocol as the catalogue keeps it, from its code: its bindings' instructions and labels, and its credentials' schema and actions without their code. */
export function protocolDeclarationOf(protocol: Protocol): ProtocolDeclaration {
  const credentials = protocol.credentials;
  return {
    id: protocol.id,
    label: protocol.label,
    bindings: Object.fromEntries(
      Object.entries(protocol.bindings).map(([transport, binding]) => [
        transport,
        { ...(binding.instructions ? { instructions: binding.instructions } : {}), ...(binding.addressLabel ? { addressLabel: binding.addressLabel } : {}) },
      ])
    ),
    ...(credentials
      ? {
          credentials: {
            schema: credentials.schema,
            ...(credentials.actions?.length ? { actions: credentials.actions.map(({ run: _run, ...action }) => action) } : {}),
            ...(credentials.first ? { first: true } : {}),
            ...(credentials.title ? { title: credentials.title } : {}),
          },
        }
      : {}),
  };
}

/** As JSON keeps it: what a catalogue read back from its file is compared as. */
export const asJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
