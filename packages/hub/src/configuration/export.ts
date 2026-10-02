import {
  automationEntryFrom,
  deviceEntryFrom,
  emptyDocument,
  unitsFrom,
  vocabularyOf,
  type ConfigDocument,
  type SecretValue,
  type Vocabulary,
  type WaySource,
  type WriteContext,
} from '@kraftverk/home-file';
import type { PrintContext } from '@kraftverk/automation';
import { methodsOf, partsOf, type NodeId, type PolicyValueName, type PolicyValues, type SavedDeviceId } from '@kraftverk/device-sdk';
import type { AutomationStore, DeviceCatalog, DeviceRecord, ConnectionStore, LinkStore, SecretsAtRest } from '@kraftverk/store';

import type { ProtocolRegistry } from '../installed/protocols.ts';
import type { DeviceTypeRegistry } from '../installed/types.ts';
import { keep, openKept, type PassphraseSealing } from './seal.ts';

/*
  A home's configuration as a document (docs/CONFIG.md): everything it has,
  or the devices and automations chosen — each by its key — with what could
  not go in said, and each secret as asked: left out, sealed with a
  passphrase, in plain text where its owner allowed that, or kept as the
  home keeps it, for the snapshot beside the database.
*/

export type ConfigDeps = {
  catalog: DeviceCatalog;
  connections: ConnectionStore;
  links: LinkStore;
  /** This node: the ways it holds are the home's own, what a file says; those another node holds stay with it. */
  self: NodeId;
  automations: AutomationStore;
  types: DeviceTypeRegistry;
  protocols: ProtocolRegistry;
  /** The home's own values: how much is a load, the reserve. */
  policy: { values(): PolicyValues; set(name: PolicyValueName, value: number | null): PolicyValues };
  /** How a passphrase seals a secret, and opens it: the place's. */
  sealing: PassphraseSealing;
  /** How the home seals its own secrets at rest: what the snapshot keeps them in. */
  kept: SecretsAtRest;
};

/**
 * How secrets go into an export:
 * - `none` — left out, each one said;
 * - `sealed` — sealed with the passphrase given, under `secrets`;
 * - `plain` — as they are, only for connections whose owner allowed it;
 * - `kept` — as the home keeps them: the snapshot's, never sent anywhere.
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

/** What a configuration may name in this home: its installed types, and the keys it has. */
export function homeVocabulary(deps: Pick<ConfigDeps, 'catalog' | 'automations' | 'types' | 'protocols'>): Vocabulary {
  return vocabularyOf(deps.types.all(), (id) => deps.protocols.get(id), {
    devices: deps.catalog.list().map((device) => ({ key: device.key, type: device.typeId, name: device.name, parts: partsOf(device.description).map((part) => part.id) })),
    automations: deps.automations.list().map((automation) => ({ key: automation.key, name: automation.name })),
  });
}

/** The configuration, as asked. */
export async function exportConfig(deps: ConfigDeps, options: ExportOptions): Promise<Exported> {
  if (options.secrets === 'sealed' && !options.passphrase) throw new Error('Sealing secrets needs a passphrase');
  const document = emptyDocument();
  const notes: string[] = [];
  const everything = !options.devices && !options.automations;

  const devices = deps.catalog.list().filter((device) => !options.devices || options.devices.includes(device.key));
  const automations = deps.automations.list().filter((automation) => !options.automations || options.automations.includes(automation.key));
  if (options.devices) for (const key of options.devices) if (!devices.some((device) => device.key === key)) notes.push(`There is no device "${key}"`);
  if (options.automations) for (const key of options.automations) if (!automations.some((automation) => automation.key === key)) notes.push(`There is no automation "${key}"`);

  if (everything) document.home.policy = { ...deps.policy.values() };

  // The secrets, as asked.
  const secret = async (device: DeviceRecord, connection: { id: string; secretsExportable: boolean }, field: string): Promise<SecretValue | null> => {
    const value = deps.connections.secret(connection.id, field);
    if (value === null) {
      notes.push(`${device.name}'s ${field} could not be read: the key that sealed it is gone. Give it again after importing`);
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
        document.secrets[name] = await deps.sealing.seal(options.passphrase!, value);
        return { secret: name };
      case 'kept': {
        const before = options.keptBefore?.[name];
        document.secrets[name] = before !== undefined && openKept(deps.kept, before) === value ? before : keep(deps.kept, value);
        return { secret: name };
      }
    }
  };

  for (const device of devices) {
    const type = deps.types.get(device.typeId);
    const ways: WaySource[] = [];
    for (const connection of deps.connections.forDevice(device.id)) {
      if (connection.heldBy !== deps.self) {
        notes.push(`${device.name} is also reached by an app, which keeps that way and its keys itself: left out`);
        continue;
      }
      const method = type ? methodsOf(type).find((each) => each.id === connection.method) : undefined;
      const secrets: Record<string, SecretValue> = {};
      for (const field of deps.connections.secretFields(connection.id)) {
        const value = await secret(device, connection, field);
        if (value) secrets[field] = value;
      }
      ways.push({ method: connection.method, address: connection.address, config: connection.config, secrets, exportable: connection.secretsExportable, fixedAddress: Boolean(method?.address) });
    }
    document.devices[device.key] = deviceEntryFrom(device, ways);
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
  if (elsewhere.size && !everything) notes.push(`It names devices this file does not carry, which the home it goes to must have: ${[...elsewhere].sort().join(', ')}`);

  return { document, notes, context: { unitIn: (automation, role, means) => units.get(automation)?.unitOf?.(role, means) ?? null } };
}
