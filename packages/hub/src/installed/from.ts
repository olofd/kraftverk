import type { AutomationContribution } from '@kraftverk/automation';
import type { DeviceType, FileMigration, Protocol, TransportDefinition, TransportFactory } from '@kraftverk/device-sdk';

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
 * One integration as installed (docs/PLAN-INTEGRATIONS.md §1): the platform,
 * its own types — accounts, gateways, services, the generic one — and the
 * products the device packages built on it declare.
 */
export type InstalledIntegration = {
  id: string;
  name: string;
  types: readonly InstalledType[];
  products: readonly InstalledType[];
  /** How its entries in a configuration file changed, version by version: a home kept before comes back after. */
  migrations?: readonly FileMigration[];
};

/**
 * What a place has installed, as lists — an app's generated registry, a
 * test's own — rather than found on a disk as the server finds it.
 */
export type InstalledLists = {
  /** Each integration, with its own types and the products on it. */
  integrations: readonly InstalledIntegration[];
  protocols: readonly Protocol[];
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
  for (const protocol of lists.protocols) protocols.install(protocol);
  const transports = new TransportHost(host);
  for (const { definition, create } of lists.transports) transports.install(definition, create ? { create } : null);
  const types = new DeviceTypeRegistry();
  for (const integration of lists.integrations) installIntegration(types, integration);
  types.checkConnections({ protocol: (id) => protocols.get(id), transport: (id) => transports.definition(id) });
  return { types, protocols, transports };
}

/**
 * One integration into a registry: the platform, the products on it, then
 * its own types, each with what it brings to automations. Products come
 * first because that is the order a person is offered them in: the
 * platform's generic type is the one to take when no product is yours.
 */
export function installIntegration(types: DeviceTypeRegistry, integration: InstalledIntegration, source = integration.id): void {
  const info = { id: integration.id, name: integration.name };
  if (types.installIntegration(info, source, integration.migrations ?? []).length) return;
  for (const [entries, product] of [[integration.products, true], [integration.types, false]] as const) {
    for (const { type, automation } of entries) {
      if (types.install(type, { integration: info, product }, `${source} (${type.id ?? 'a type'})`).length) continue;
      if (automation) types.contribute(type, automation, `${source} (${type.id})`);
    }
  }
}

/**
 * Starts the transports an installed type reaches its devices over, where
 * they run here: finding a device has to work before there is one to open.
 * One that cannot run here is said, and the others carry on. What no type
 * uses is never started — a broker nobody connects to, a radio nobody asks.
 */
export async function startTransports(installed: Installed, log: (level: 'warn', message: string) => void): Promise<void> {
  const { types, transports } = installed;
  const used = new Set(types.all().flatMap((type) => type.connections.map((method) => method.transport)));
  const starting = transports.here().filter((id) => used.has(id));
  await transports.startAll(starting);
  for (const id of starting) {
    const available = transports.available(id);
    if (!available.ok) log('warn', `[transports] ${id} is unavailable here: ${available.reason}`);
  }
}
