import {
  emptyDocument,
  vocabularyOf,
  type AutomationEntry,
  type ConfigDocument,
  type ConnectEntry,
  type DeviceEntry,
  type Mode,
  type Scalar,
  type SecretValue,
  type Use,
  type Vocabulary,
  type WriteContext,
} from '@kraftverk/config';
import { attributeMeaning, methodsOf, partsOf, unitOf, type SavedDeviceId } from '@kraftverk/device-sdk';

import type { AutomationMode, AutomationRecord } from '../automations/engine.ts';
import type { AutomationStore } from '../automations/store.ts';
import type { DeviceCatalog, DeviceRecord } from '../devices/catalog.ts';
import type { ConnectionStore } from '../devices/connections.ts';
import type { LinkStore } from '../devices/links.ts';
import type { DeviceTypeRegistry } from '../devices/types.ts';
import { policyValues } from '../history/policy.ts';
import type { ProtocolRegistry } from '../runtime/protocols.ts';
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

const MODE: Record<AutomationMode, Mode> = { off: 'off', observe: 'watch', armed: 'act' };

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
      connect.push({ via: connection.method, address: method?.address ? null : connection.address, settings: scalars(connection.config), secrets });
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
  const keyOfDevice = (id: SavedDeviceId): string | null => deps.catalog.get(id)?.key ?? null;
  const elsewhere = new Set<string>();
  const units = new Map<string, (role: string, means: string) => string | null>();
  for (const automation of automations) {
    const uses: Record<string, Use> = {};
    for (const [role, binding] of Object.entries(automation.roles)) {
      const key = keyOfDevice(binding.device);
      if (!key) {
        notes.push(`"${automation.name}": ${role} was filled by a device that is gone`);
        continue;
      }
      uses[role] = { device: key, part: binding.part };
      if (!carried.has(binding.device)) elsewhere.add(key);
    }
    for (const [role, started] of Object.entries(automation.starts)) {
      const other = deps.automations.get(started);
      if (other) uses[role] = { automation: other.key };
    }
    document.automations[automation.key] = entryOf(automation, uses);
    units.set(automation.key, unitsOf(deps, automation));
  }
  if (elsewhere.size && !everything) notes.push(`It names devices this file does not carry, which the server it goes to must have: ${[...elsewhere].sort().join(', ')}`);

  return { document, notes, context: { unitIn: (automation, role, means) => units.get(automation)?.(role, means) ?? null } };
}

const entryOf = (automation: AutomationRecord, uses: Record<string, Use>): AutomationEntry => ({
  name: automation.name,
  mode: MODE[automation.mode],
  clock: automation.timeZone,
  recheckMinutes: automation.recheckMinutes,
  homePlace: automation.homePlace,
  madeFrom: automation.madeFrom,
  uses,
  rule: automation.rule,
});

/** The unit of what each role of an automation reads, from the part filling it: what a number beside it is written in. */
function unitsOf(deps: ConfigDeps, automation: AutomationRecord): (role: string, means: string) => string | null {
  return (role, means) => {
    const binding = automation.roles[role];
    const device = binding ? deps.catalog.get(binding.device) : null;
    const attribute = device ? attributeMeaning(device.description, binding!.part, means) : null;
    return attribute ? unitOf(attribute) || null : null;
  };
}
