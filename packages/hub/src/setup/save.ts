import {
  isLinkKind,
  isSecretField,
  linkFits,
  linkKindSpec,
  savedDeviceId,
  validateConfig,
  type ConfigSchema,
  type ConfigValues,
  type NodeId,
  type SavedDeviceId,
} from '@kraftverk/device-sdk';

import { ApiError } from '@kraftverk/api-contract';
import type { DeviceCatalog, DeviceRecord, ConnectionStore, LinkStore } from '@kraftverk/store';
import { connectionSchema } from '../installed/connection-schema.ts';
import type { Draft, SaveRequest } from './draft.ts';

/**
 * Saving a draft: what it may be saved as, and the one write — the device (or
 * the one it turned out to be), its connection, that connection's secrets and
 * its links, all or nothing.
 */

export type SaveDeps = { catalog: DeviceCatalog; connections: ConnectionStore; links: LinkStore; self: NodeId };

/** Whether the check lets it be saved, and its device's and connection's config as they will be kept. Throws why not. */
export function saveable(draft: Draft, input: SaveRequest, self: NodeId): { device: ConfigValues; connection: ConfigValues } {
  const { checked, type } = draft;
  if (!draft.address) throw new ApiError('invalid', 'Choose the device first');
  if (!checked) throw new ApiError('invalid', 'Check that it answers first');
  if (checked.outcome === 'other-model') throw new ApiError('conflict', checked.summary);
  if (checked.outcome === 'no-answer' && !(input.anyway && type.setup?.saveAnyway)) {
    throw new ApiError('conflict', type.setup?.saveAnyway ? 'It did not answer. Save it anyway, or try again.' : 'It did not answer, so it cannot be saved.');
  }

  const device = validateConfig(type.config, draft.device);
  if (!device.ok) throw new ApiError('invalid', device.issues.map((issue) => issue.message).join('; '));
  const schema = connectionSchema(draft.method, draft.reach.protocol);
  const nonSecret: ConfigSchema = {
    fields: Object.fromEntries(
      Object.entries(schema.fields)
        .filter(([, spec]) => !isSecretField(spec))
        .map(([field, spec]) => [field, draft.reach.strict ? spec : { ...spec, required: false }])
    ),
  };
  const connection = validateConfig(nonSecret, Object.fromEntries(Object.entries(draft.connection).filter(([field]) => field in nonSecret.fields)));
  if (!connection.ok) throw new ApiError('invalid', connection.issues.map((issue) => issue.message).join('; '));
  // A key this node will need, when it will hold it. A node that follows the home keeps its own.
  if (draft.reach.strict && draft.heldBy === self) {
    for (const [field, spec] of Object.entries(schema.fields)) {
      if (isSecretField(spec) && spec.required && !draft.secrets.get(field)) throw new ApiError('invalid', `${spec.title} is required`);
    }
  }
  return { device: device.value, connection: connection.value };
}

/** Which device this is: one you have, one you had, or a new one. */
function deviceFor(deps: SaveDeps, draft: Draft, input: SaveRequest, deviceConfig: ConfigValues): { record: DeviceRecord; kind: string } {
  const checked = draft.checked!;
  const { type } = draft;
  const method = draft.method!;

  if (input.mode === 'attach') {
    const existing = input.deviceId ? deps.catalog.active(input.deviceId as SavedDeviceId) : null;
    if (!existing) throw new ApiError('not-found', 'That device has gone');
    if (existing.typeId !== type.id) throw new ApiError('conflict', `${existing.name} is not a ${type.meta.name}`);
    /*
      Another way to reach a device must reach *that* device: the check has
      to find it. The one exception is a device saved before it ever answered,
      which has no identity yet — the first to find one gives it.
    */
    const same = checked.outcome === 'yours' && checked.device.id === existing.id;
    const first = checked.outcome === 'new' && existing.identity === null;
    // A browser shows no MAC, so its answer cannot say which station it is: then the person says.
    const onTheirWord = checked.outcome === 'new' && checked.identity === null;
    if (!same && !first && !onTheirWord) throw new ApiError('conflict', `That is a different device, not ${existing.name}`);
    if (first && checked.identity) deps.catalog.update(existing.id, { identity: checked.identity });
    if (deps.connections.forDevice(existing.id).some((c) => c.method === method.id && (draft.through ? c.through === draft.through : c.heldBy === draft.heldBy))) {
      throw new ApiError('conflict', `${existing.name} is already reached this way`);
    }
    return { record: existing, kind: 'device.connection-added' };
  }

  if (input.mode === 'restore') {
    if (checked.outcome !== 'removed' || !checked.devices.some((candidate) => candidate.id === input.deviceId)) {
      throw new ApiError('conflict', 'That is not a device this was before');
    }
    const restored = deps.catalog.restore(input.deviceId as SavedDeviceId);
    if (!restored) throw new ApiError('conflict', 'That device cannot be brought back');
    return { record: deps.catalog.update(restored.id, { name: input.name.trim() || restored.name, config: deviceConfig }) ?? restored, kind: 'device.restored' };
  }

  if (checked.outcome === 'yours') throw new ApiError('conflict', `You already have this device: ${checked.device.name}`);
  const identity = checked.outcome === 'new' || checked.outcome === 'removed' ? (checked.identity ?? null) : null;
  const record = deps.catalog.add({ typeId: type.id, name: input.name.trim() || type.meta.name, identity, config: deviceConfig, description: type.describe(deviceConfig) });
  return { record, kind: 'device.added' };
}

/** The write itself. Run it in one transaction: a device saved without its connection could never be reached. */
export function writeSaved(deps: SaveDeps, draft: Draft, input: SaveRequest, config: { device: ConfigValues; connection: ConfigValues }): { record: DeviceRecord; kind: string } {
  const method = draft.method!;
  const address = draft.address!;
  const { record, kind } = deviceFor(deps, draft, input, config.device);

  // An exclusive address belongs to one device; a member's key, to one member of its bridge.
  if (draft.through) {
    const claim = deps.connections.member(draft.through, address);
    if (claim && claim.deviceId !== record.id) throw new ApiError('conflict', 'Another device you have is already that one behind it');
  } else if (draft.reach.exclusive && draft.heldBy === deps.self) {
    const claim = deps.connections.claimant(method.transport, address);
    if (claim && claim.deviceId !== record.id) throw new ApiError('conflict', 'Another device you have is already reached at that address');
  }

  const holding = draft.through ? { through: draft.through } : { heldBy: draft.heldBy };
  const saved = deps.connections.add({ deviceId: record.id, method: method.id, transport: method.transport, ...holding, address, config: config.connection, secretsExportable: draft.heldBy === deps.self && input.secretsExportable === true });
  if (draft.secrets.size) deps.connections.setSecrets(saved.id, Object.fromEntries(draft.secrets));

  for (const link of input.links ?? []) {
    if (!isLinkKind(link.kind)) throw new ApiError('invalid', `There is no link called "${link.kind}"`);
    const other = deps.catalog.active(savedDeviceId(link.other.device));
    if (!other) throw new ApiError('not-found', 'The device to link to has gone');
    const mine = { device: record.id, part: link.part, description: record.description };
    const theirs = { device: other.id, part: link.other.part, description: other.description };
    const [source, target] = link.role === 'source' ? [mine, theirs] : [theirs, mine];
    if (!linkFits(link.kind, source.description, source.part, target.description, target.part)) throw new ApiError('invalid', `"${linkKindSpec(link.kind).verb}" does not fit those two parts`);
    deps.links.add({ kind: link.kind, source: { device: source.device, part: source.part }, target: { device: target.device, part: target.part } });
  }
  return { record, kind };
}
