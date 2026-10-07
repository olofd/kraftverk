import type { AutomationContribution } from '@kraftverk/automation';
import type { CatalogueType, DeviceType, FileMigration, PackageCatalogue, Protocol, TransportDefinition, TransportFactory } from '@kraftverk/device-sdk';

import { ProtocolRegistry } from './protocols.ts';
import { TransportHost, type TransportHostOptions } from './transports.ts';
import { DeviceTypeRegistry } from './types.ts';

/**
 * What is installed where a home runs: its integrations and the device types
 * they and the device packages on them declare (and what those bring to
 * automations), protocols and transports. The place fills them — the server
 * from its disk, the app from its generated registry, a test with what it
 * brings — and the hub runs what is in them.
 */
export type Installed = {
  types: DeviceTypeRegistry;
  protocols: ProtocolRegistry;
  transports: TransportHost;
};

/** One device type, and what its package brings to automations beside it. */
export type InstalledType = { type: DeviceType<any>; automation?: AutomationContribution | null };

/**
 * One integration as installed (docs/PLAN-INTEGRATIONS.md §1.1): the platform,
 * the protocols it speaks to its service in, its own types — accounts, gateways, services, the generic one — and the
 * products the device packages built on it declare.
 */
export type InstalledIntegration = {
  id: string;
  name: string;
  /** How it speaks to its service: each protocol's id is its own, or begins with it. */
  protocols: readonly Protocol[];
  types: readonly InstalledType[];
  products: readonly InstalledType[];
  /** How its entries in a configuration file changed, version by version: a home kept before comes back after. */
  migrations?: readonly FileMigration[];
};

/** An integration's code, as its loader brings it: its protocols, its own types and the products on it. */
export type IntegrationCode = Pick<InstalledIntegration, 'protocols' | 'types' | 'products'>;

/**
 * One integration as installed before its code is (docs/PLAN-INTEGRATIONS.md
 * §6.1): its catalogue — its protocols, its own types, and the products on
 * it, each as data — now, and its code when it is first needed. What the
 * server finds on its disk, and the app's generated list carries.
 */
export type LazyIntegration = {
  id: string;
  name: string;
  /** Its own catalogue: its protocols and its own types. */
  catalogue: PackageCatalogue;
  /** The products the device packages on it declare, from each package's catalogue. */
  products: readonly CatalogueType[];
  migrations?: readonly FileMigration[];
  /** Imports its code, and the products' on it. */
  load(): Promise<IntegrationCode>;
};

/** Whether an integration comes with its code already, or loads it when needed. */
export const isLazy = (integration: InstalledIntegration | LazyIntegration): integration is LazyIntegration => 'load' in integration;

/**
 * What a place has installed, as lists — an app's generated registry, a
 * test's own — rather than found on a disk as the server finds it.
 */
export type InstalledLists = {
  /** Each integration, with its protocols, its own types and the products on it — imported already, or loaded when needed. */
  integrations: readonly (InstalledIntegration | LazyIntegration)[];
  /**
   * Each transport's definition, and how it is made where the hub runs: its
   * entry for this place, or one that reaches it in another realm — a
   * browser's page, for a hub in its worker. Null where it cannot run here.
   */
  transports: readonly { definition: TransportDefinition; create: TransportFactory | null }[];
};

/**
 * The registries a hub is made from, from lists (`createHub`'s `installed`):
 * each installed and checked as the server's discovery does it, a package
 * that breaks the rules refused with why, and the rest installed.
 */
export function installedFrom(lists: InstalledLists, host: TransportHostOptions): Installed {
  const protocols = new ProtocolRegistry();
  const transports = new TransportHost(host);
  for (const { definition, create } of lists.transports) transports.install(definition, create ? { create } : null);
  const types = new DeviceTypeRegistry();
  protocols.loadsWith((integration) => types.loadIntegration(integration));
  for (const integration of lists.integrations) installIntegration({ types, protocols }, integration);
  types.checkConnections({ protocols, transport: (id) => transports.definition(id) });
  return { types, protocols, transports };
}

/**
 * One integration into the registries: its protocols, the products on it,
 * then its own types, each with what it brings to automations. Products come
 * first because that is the order a person is offered them in: the
 * platform's generic type is the one to take when no product is yours.
 *
 * One already imported is installed with its code. One that loads when
 * needed is declared from its catalogue, and its code — checked against the
 * contract, and against the catalogue — installed when it is first asked for.
 */
export function installIntegration(
  { types, protocols }: Pick<Installed, 'types' | 'protocols'>,
  integration: InstalledIntegration | LazyIntegration,
  source = integration.id
): void {
  const info = { id: integration.id, name: integration.name };
  if (types.installIntegration(info, source, integration.migrations ?? []).length) return;
  const where = (id: string | undefined, what: string) => `${source} (${id ?? what})`;
  if (!isLazy(integration)) {
    for (const protocol of integration.protocols) protocols.install(protocol, integration.id, where(protocol.id, 'a protocol'));
    for (const [entries, product] of [[integration.products, true], [integration.types, false]] as const) {
      for (const { type, automation } of entries) {
        if (types.install(type, { integration: info, product }, where(type.id, 'a type')).length) continue;
        if (automation) types.contribute(type, automation, where(type.id, 'a type'));
      }
    }
    return;
  }
  for (const protocol of integration.catalogue.protocols) protocols.declare(protocol, integration.id, where(protocol.id, 'a protocol'));
  const declared = new Set<string>();
  for (const [entries, product] of [[integration.products, true], [integration.catalogue.types, false]] as const) {
    for (const { automation: _automation, ...entry } of entries) {
      if (!types.declare(entry, { integration: info, product }, where(entry.id, 'a type')).length) declared.add(entry.id);
    }
  }
  types.loadsWith(integration.id, async () => {
    const code = await integration.load();
    for (const protocol of code.protocols) protocols.provide(protocol, where(protocol.id, 'a protocol'));
    for (const { type, automation } of [...code.products, ...code.types]) {
      // What was refused when it was declared stays refused: its code changes nothing of that.
      if (!declared.has(type.id) || types.provide(type, where(type.id, 'a type')).length) continue;
      if (automation) types.contribute(type, automation, where(type.id, 'a type'));
    }
  });
}

/**
 * Starts the transports an installed type reaches its devices over, where
 * they run here: finding a device has to work before there is one to open.
 * One that cannot run here is said, and the others carry on. What no type
 * uses is never started — a broker nobody connects to, a radio nobody asks.
 */
export async function startTransports(installed: Installed, log: (level: 'warn', message: string) => void): Promise<void> {
  const { types, transports } = installed;
  const used = new Set(types.all().flatMap((type) => type.connections.flatMap((method) => (method.transport ? [method.transport] : []))));
  const starting = transports.here().filter((id) => used.has(id));
  await transports.startAll(starting);
  for (const id of starting) {
    const available = transports.available(id);
    if (!available.ok) log('warn', `[transports] ${id} is unavailable here: ${available.reason}`);
  }
}
