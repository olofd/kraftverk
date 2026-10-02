import {
  automationEntryFrom,
  emptyDocument,
  unitsFrom,
  vocabularyOf,
  type ConfigDocument,
  type ConnectEntry,
  type DeviceEntry,
  type Scalar,
  type SecretValue,
  type Vocabulary,
  type WriteContext,
} from '@kraftverk/home-file';
import type { PrintContext } from '@kraftverk/automation';
import { methodsOf, partsOf, type SavedDeviceId } from '@kraftverk/device-sdk';

import type { AutomationStore, DeviceCatalog, DeviceRecord, ConnectionStore, LinkStore } from '@kraftverk/store';
import type { DeviceTypeRegistry, ProtocolRegistry } from '@kraftverk/hub';
import { policyValues } from '../platform/database.ts';
import { keep, openKept, sealWith } from './seal.ts';

/*
  The server's configuration as a document (docs/CONFIG.md): everything it
  has, or the devices and automations chosen — each by its key — with what
  could not go in said, and each secret as asked: left out, sealed with a
  passphrase, in plain text where its owner allowed that, or kept as the
  server keeps it, for the snapshot beside the database.
*/

export type ConfigDeps = {
  catalog: DeviceCatalog;
  connections: ConnectionStore;
  links: LinkStore;
  automations: AutomationStore;
  types: DeviceTypeRegistry;
  protocols: ProtocolRegistry;
};

/**
 * How secrets go into an export:
 * - `none` — left out, each one said;
 * - `sealed` — sealed with the passphrase given, under `secrets`;
 * - `plain` — as they are, only for connections whose owner allowed it;
 * - `kept` — as the server keeps them: the snapshot's, never sent anywhere.
 */
export type SecretsMode = 'none' | 'sealed' | 'plain' | 'kept';

export type ExportOptions = {
  /** Which devices, by key; all of them when not given. */
  devices?: readonly string[];
  /** Which automations, by key; all of them when not given. */
  automations?: readonly string[];
  secrets: SecretsMode;
  passphrase?: string;
  /**
   * Kept: how each secret was kept before, by its name — reused while it
   * still opens to the same value, so a snapshot that has not changed is not
   * written again for a fresh seal of the same key.
   */
  keptBefore?: Record<string, string>;
};

export type Exported = {
  document: ConfigDocument;
  /** What could not go in, or went in otherwise than asked: said in the file's heading and to whoever exported it. */
  notes: string[];
  /** How the file is written: each number beside a reading in its unit. */
  context: WriteContext;
};

/** What a configuration may name on this server: its installed types, and the keys it has. */
export function serverVocabulary(deps: ConfigDeps): Vocabulary {
  return vocabularyOf(deps.types.all(), (id) => deps.protocols.get(id), {
    devices: deps.catalog.list().map((device) => ({ key: device.key, type: device.typeId, name: device.name, parts: partsOf(device.description).map((part) => part.id) })),
    automations: deps.automations.list().map((automation) => ({ key: automation.key, name: automation.name })),
  });
}

const scalars = (values: Record<string, unknown>): Record<string, Scalar> =>
  Object.fromEntries(Object.entries(values).filter((entry): entry is [string, Scalar] => typeof entry[1] === 'string' || typeof entry[1] === 'number' || typeof entry[1] === 'boolean'));

/** The configuration, as asked. */
export function exportConfig(deps: ConfigDeps, options: ExportOptions): Exported {
  if (options.secrets === 'sealed' && !options.passphrase) throw new Error('Sealing secrets needs a passphrase');
  const document = emptyDocument();
  const notes: string[] = [];
  const everything = !options.devices && !options.automations;

  const devices = deps.catalog.list().filter((device) => !options.devices || options.devices.includes(device.key));
  const automations = deps.automations.list().filter((automation) => !options.automations || options.automations.includes(automation.key));
  if (options.devices) for (const key of options.devices) if (!devices.some((device) => device.key === key)) notes.push(`There is no device "${key}"`);
  if (options.automations) for (const key of options.automations) if (!automations.some((automation) => automation.key === key)) notes.push(`There is no automation "${key}"`);

  if (everything) document.home.policy = { ...policyValues() };

  // The secrets, as asked.
  const secret = (device: DeviceRecord, connection: { id: string; secretsExportable: boolean }, field: string): SecretValue | null => {
    const value = deps.connections.secret(connection.id, field);
    if (value === null) {
      notes.push(`${device.name}'s ${field} could not be read: the server's key that sealed it is gone. Give it again after importing`);
      return null;
    }
    const name = `${device.key}.${field}`;
    switch (options.secrets) {
      case 'none':
        notes.push(`${device.name}'s ${field} is left out: give it again after importing`);
        return null;
      case 'plain':
        if (connection.secretsExportable) return { plain: value };
        notes.push(`${device.name}'s ${field} is left out: its owner has not let it leave in plain text`);
        return null;
      case 'sealed':
        document.secrets[name] = sealWith(options.passphrase!, value);
        return { secret: name };
      case 'kept': {
        const before = options.keptBefore?.[name];
        document.secrets[name] = before !== undefined && openKept(before) === value ? before : keep(value);
        return { secret: name };
      }
    }
  };

  for (const device of devices) {
    const type = deps.types.get(device.typeId);
    const connect: ConnectEntry[] = [];
    for (const connection of deps.connections.forDevice(device.id)) {
      if (connection.heldBy !== null) {
        notes.push(`${device.name} is also reached by an app, which keeps that way and its keys itself: left out`);
        continue;
      }
      const method = type ? methodsOf(type).find((each) => each.id === connection.method) : undefined;
      const secrets: Record<string, SecretValue> = {};
      for (const field of deps.connections.secretFields(connection.id)) {
        const value = secret(device, connection, field);
        if (value) secrets[field] = value;
      }
      connect.push({ via: connection.method, address: method?.address ? null : connection.address, settings: scalars(connection.config), secrets, exportable: connection.secretsExportable });
    }
    const entry: DeviceEntry = { type: device.typeId, name: device.name, identity: device.identity, picture: device.picture, settings: scalars(device.config), connect };
    document.devices[device.key] = entry;
  }

  // Links between the devices it carries.
  const carried = new Map(devices.map((device) => [device.id as string, device.key]));
  for (const link of deps.links.all()) {
    const from = carried.get(link.source.device);
    const to = carried.get(link.target.device);
    if (from && to) document.links.push({ kind: link.kind, from: { device: from, part: link.source.part }, to: { device: to, part: link.target.part } });
    else if (from || to) notes.push(`A link to a device not in this file is left out: ${from ?? to} ${link.kind} another`);
  }

  // Automations: what fills each role, by key.
  // A device you removed fills nothing in a file: its role is written empty, and said.
  const keyOf = { device: (id: string) => { const device = deps.catalog.get(id as SavedDeviceId); return device && !device.removedAt ? device.key : null; }, automation: (id: string) => deps.automations.get(id)?.key ?? null };
  const describe = (id: string) => deps.catalog.get(id as SavedDeviceId)?.description ?? null;
  const elsewhere = new Set<string>();
  const units = new Map<string, PrintContext>();
  for (const automation of automations) {
    const { entry, gone } = automationEntryFrom(automation, keyOf);
    for (const role of gone) notes.push(`"${automation.name}": ${automation.rule.roles[role]?.label ?? role} was filled by ${role in automation.starts ? 'an automation' : 'a device'} that is gone: written empty`);
    for (const binding of Object.values(automation.roles)) {
      const key = keyOf.device(binding.device);
      if (key && !carried.has(binding.device)) elsewhere.add(key);
    }
    document.automations[automation.key] = entry;
    units.set(automation.key, unitsFrom(automation.roles, describe));
  }
  if (elsewhere.size && !everything) notes.push(`It names devices this file does not carry, which the server it goes to must have: ${[...elsewhere].sort().join(', ')}`);

  return { document, notes, context: { unitIn: (automation, role, means) => units.get(automation)?.unitOf?.(role, means) ?? null } };
}
