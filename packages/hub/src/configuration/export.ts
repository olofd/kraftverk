import {
  automationEntryFrom,
  deviceEntryFrom,
  emptyDocument,
  vocabularyOf,
  type ConfigDocument,
  type OpeningEntry,
  type PlaceEntry,
  type SpaceEntry,
  type SecretValue,
  type Vocabulary,
  type WaySource,
} from '@kraftverk/home-file';
import { methodsOf, partsOf, type NodeId, type PolicyValueName, type PolicyValues, type SavedDeviceId } from '@kraftverk/device-sdk';
import type { AutomationStore, DeviceCatalog, DeviceRecord, ConnectionStore, FamilyStore, LinkStore, MediaStore, LabelStore, PlaceStore, SecretsAtRest, SpaceStore } from '@kraftverk/store';
import type { SpaceView } from '@kraftverk/api-contract';

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
  /** The family itself: its name, kind and language. */
  family: FamilyStore;
  /** Its homes: where each is, its clock. */
  places: PlaceStore;
  /** Their spaces and openings, and where each device stands. */
  spaces: SpaceStore;
  /** Its labels, and what each is on. */
  labels: LabelStore;
  /** Pictures, by their content: what a home or a device in a file names. */
  media: MediaStore;
  /** A home's own values: how much is a load, the reserve. */
  policyOf(homeId: string): { values(): PolicyValues; set(name: PolicyValueName, value: number | null): PolicyValues };
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
};

/** What a configuration may name in this home: its installed types, and the keys it has. */
export function homeVocabulary(deps: Pick<ConfigDeps, 'catalog' | 'automations' | 'types' | 'protocols' | 'places'>): Vocabulary {
  return vocabularyOf(deps.types.all(), (id) => deps.protocols.get(id), {
    devices: deps.catalog.list().map((device) => ({ key: device.key, type: device.typeId, name: device.name, parts: partsOf(device.description).map((part) => part.id) })),
    automations: deps.automations.list().map((automation) => ({ key: automation.key, name: automation.name })),
    homes: deps.places.homes().map((home) => ({ key: home.key, name: home.name })),
  });
}

/** A home's spaces as a file has them: the tree under its site, each by its key. */
function spaceTree(spaces: readonly SpaceView[], labelsOf: (spaceId: string) => string[]): SpaceEntry[] {
  const under = (parent: string): SpaceEntry[] =>
    spaces
      .filter((space) => space.parentId === parent)
      .map((space) => ({
        key: space.key,
        kind: space.kind as SpaceEntry['kind'],
        name: space.name,
        purpose: space.purpose,
        level: space.level,
        elevation: space.elevation,
        height: space.height,
        labels: labelsOf(space.id),
        spaces: under(space.id),
      }));
  const site = spaces.find((space) => space.kind === 'site');
  return site ? under(site.id) : [];
}

/** A home's openings as a file has them: each by its key, its spaces by theirs. One from the site itself has no space to name, and is left out. */
function openingsOf(spaces: SpaceStore, homeId: string): Record<string, OpeningEntry> {
  const keys = new Map(spaces.spaces(homeId).map((space) => [space.id, space.kind === 'site' ? null : space.key]));
  return Object.fromEntries(
    spaces.openings(homeId).flatMap((opening) => {
      const from = keys.get(opening.fromId) ?? null;
      const to = opening.toId === null ? null : (keys.get(opening.toId) ?? undefined);
      return from && to !== undefined ? [[opening.key, { kind: opening.kind, from, to, name: opening.name }]] : [];
    })
  );
}

/** Where a device stands, by keys: its home, its space — none for the site — perhaps an opening. */
export function placeOf(deps: Pick<ConfigDeps, 'places' | 'spaces'>, deviceId: SavedDeviceId): PlaceEntry | null {
  const placed = deps.spaces.placement(deviceId);
  if (!placed) return null;
  const home = deps.places.home(placed.homeId);
  const space = deps.spaces.space(placed.spaceId);
  if (!home || home.removedAt || !space) return null;
  return {
    home: home.key,
    space: space.kind === 'site' ? null : space.key,
    opening: placed.openingId ? (deps.spaces.opening(placed.openingId)?.key ?? null) : null,
    role: placed.role,
  };
}

/** The configuration, as asked. */
export async function exportConfig(deps: ConfigDeps, options: ExportOptions): Promise<Exported> {
  if (options.secrets === 'sealed' && !options.passphrase) throw new Error('Sealing secrets needs a passphrase');
  const document = emptyDocument();
  const notes: string[] = [];
  const everything = !options.devices && !options.automations;
  // Labels by key: what a file names them by. Each one something it carries is labelled with goes in it, and every one when it is the whole home.
  const allLabels = deps.labels.list();
  const keyOfLabel = new Map(allLabels.map((label) => [label.id, label.key]));
  const labelled = deps.labels.labelled();
  const used = new Set<string>();
  const labelKeys = (ids: readonly string[] | undefined) => (ids ?? []).flatMap((id) => (keyOfLabel.has(id) ? (used.add(id), [keyOfLabel.get(id)!]) : []));

  const devices = deps.catalog.list().filter((device) => !options.devices || options.devices.includes(device.key));
  const automations = deps.automations.list().filter((automation) => !options.automations || options.automations.includes(automation.key));
  if (options.devices) for (const key of options.devices) if (!devices.some((device) => device.key === key)) notes.push(`There is no device "${key}"`);
  if (options.automations) for (const key of options.automations) if (!automations.some((automation) => automation.key === key)) notes.push(`There is no automation "${key}"`);

  if (everything) {
    const family = deps.family.get();
    if (family) document.family = { name: family.name, kind: family.kind, locale: family.locale };
    for (const home of deps.places.homes()) {
      document.homes[home.key] = {
        name: home.name,
        type: home.type,
        picture: home.pictureId,
        location: home.location,
        timeZone: home.timeZone,
        address: home.address,
        country: home.country,
        policy: { ...deps.policyOf(home.id).values() },
        spaces: spaceTree(deps.spaces.spaces(home.id), (id) => labelKeys(labelled.spaces[id])),
        openings: openingsOf(deps.spaces, home.id),
      };
    }
  }

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
      if (connection.heldBy !== null && connection.heldBy !== deps.self) {
        notes.push(`${device.name} is also reached by an app, which keeps that way and its keys itself: left out`);
        continue;
      }
      // Through a bridge: named by its key, as a file names any device — one it carries, or one the home it goes to has.
      const bridge = connection.through !== null ? deps.catalog.active(connection.through) : null;
      if (connection.through !== null && !bridge) {
        notes.push(`${device.name} is reached through a device that is gone: that way is left out`);
        continue;
      }
      const method = type ? methodsOf(type).find((each) => each.id === connection.method) : undefined;
      const secrets: Record<string, SecretValue> = {};
      for (const field of deps.connections.secretFields(connection.id)) {
        const value = await secret(device, connection, field);
        if (value) secrets[field] = value;
      }
      ways.push({ method: connection.method, through: bridge?.key ?? null, address: connection.address, config: connection.config, secrets, exportable: connection.secretsExportable, fixedAddress: Boolean(method?.address) });
    }
    document.devices[device.key] = deviceEntryFrom({ ...device, place: placeOf(deps, device.id), labels: labelKeys(labelled.devices[device.id]) }, ways);
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
  const keyOf = {
    device: (id: string) => {
      const device = deps.catalog.get(id as SavedDeviceId);
      return device && !device.removedAt ? device.key : null;
    },
    automation: (id: string) => deps.automations.get(id)?.key ?? null,
    home: (id: string) => deps.places.home(id)?.key ?? null,
  };
  const elsewhere = new Set<string>();
  for (const automation of automations) {
    const { entry, gone } = automationEntryFrom({ ...automation, labels: labelKeys(labelled.automations[automation.id]) }, keyOf);
    for (const role of gone) notes.push(`"${automation.name}": ${automation.rule.roles[role]?.label ?? role} was filled by ${role in automation.starts ? 'an automation' : 'a device'} that is gone: written empty`);
    for (const binding of Object.values(automation.roles)) {
      const key = keyOf.device(binding.device);
      if (key && !carried.has(binding.device)) elsewhere.add(key);
    }
    document.automations[automation.key] = entry;
  }
  if (elsewhere.size && !everything) notes.push(`It names devices this file does not carry, which the home it goes to must have: ${[...elsewhere].sort().join(', ')}`);

  for (const label of allLabels) if (everything || used.has(label.id)) document.labels[label.key] = { name: label.name, color: label.color, icon: label.icon };
  return { document, notes };
}
