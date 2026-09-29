import {
  isLinkKind,
  isSecretField,
  linkFits,
  linkKindSpec,
  savedDeviceId,
  validateConfig,
  type ConfigSchema,
  type ConfigValues,
  type SavedDeviceId,
} from '@kraftverk/device-sdk';

import type { DeviceCatalog, DeviceRecord } from '../catalog.ts';
import type { ConnectionStore } from '../connections.ts';
import type { LinkStore } from '../links.ts';
import { connectionSchema, SetupError, type Draft, type SaveRequest } from './draft.ts';

/**
 * Saving a draft: what it may be saved as, and the one write — the device (or
 * the one it turned out to be), its connection, that connection's secrets and
 * its links, all or nothing.
 */

export type SaveDeps = { catalog: DeviceCatalog; connections: ConnectionStore; links: LinkStore };

/** Whether the check lets it be saved, and its device's and connection's config as they will be kept. Throws why not. */
export function saveable(draft: Draft, input: SaveRequest): { device: ConfigValues; connection: ConfigValues } {
  const { checked, type } = draft;
  if (!draft.address) throw new SetupError('Choose the device first');
  if (!checked) throw new SetupError('Check that it answers first');
  if (checked.outcome === 'other-model') throw new SetupError(checked.summary, 409);
  if (checked.outcome === 'no-answer' && !(input.anyway && type.setup?.saveAnyway)) {
    throw new SetupError(type.setup?.saveAnyway ? 'It did not answer. Save it anyway, or try again.' : 'It did not answer, so it cannot be saved.', 409);
  }

  const device = validateConfig(type.config, draft.device);
  if (!device.ok) throw new SetupError(device.issues.map((issue) => issue.message).join('; '));
  const schema = connectionSchema(draft.method, draft.reach.protocol);
  const nonSecret: ConfigSchema = {
    fields: Object.fromEntries(
      Object.entries(schema.fields)
        .filter(([, spec]) => !isSecretField(spec))
        .map(([field, spec]) => [field, draft.reach.strict ? spec : { ...spec, required: false }])
    ),
  };
  const connection = validateConfig(nonSecret, Object.fromEntries(Object.entries(draft.connection).filter(([field]) => field in nonSecret.fields)));
  if (!connection.ok) throw new SetupError(connection.issues.map((issue) => issue.message).join('; '));
  // A key the server will need, when the server will hold it. An app keeps its own.
  if (draft.reach.strict && draft.heldBy === null) {
    for (const [field, spec] of Object.entries(schema.fields)) {
      if (isSecretField(spec) && spec.required && !draft.secrets.get(field)) throw new SetupError(`${spec.title} is required`);
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
    if (!existing) throw new SetupError('That device has gone', 404);
    if (existing.typeId !== type.id) throw new SetupError(`${existing.name} is not a ${type.meta.name}`, 409);
    /*
      Another way to reach a device must reach *that* device: the check has
      to find it. The one exception is a device saved before it ever answered,
      which has no identity yet — the first to find one gives it.
    */
    const same = checked.outcome === 'yours' && checked.device.id === existing.id;
    const first = checked.outcome === 'new' && existing.identity === null;
    // A browser shows no MAC, so its answer cannot say which station it is: then the person says.
    const onTheirWord = checked.outcome === 'new' && checked.identity === null;
    if (!same && !first && !onTheirWord) throw new SetupError(`That is a different device, not ${existing.name}`, 409);
    if (first && checked.identity) deps.catalog.update(existing.id, { identity: checked.identity });
    if (deps.connections.forDevice(existing.id).some((c) => c.method === method.id && c.heldBy === draft.heldBy)) {
      throw new SetupError(`${existing.name} is already reached this way`, 409);
    }
    return { record: existing, kind: 'device.connection-added' };
  }

  if (input.mode === 'restore') {
    if (checked.outcome !== 'removed' || !checked.devices.some((candidate) => candidate.id === input.deviceId)) {
      throw new SetupError('That is not a device this was before', 409);
    }
    const restored = deps.catalog.restore(input.deviceId as SavedDeviceId);
    if (!restored) throw new SetupError('That device cannot be brought back', 409);
    return { record: deps.catalog.update(restored.id, { name: input.name.trim() || restored.name, config: deviceConfig }) ?? restored, kind: 'device.restored' };
  }

  if (checked.outcome === 'yours') throw new SetupError(`You already have this device: ${checked.device.name}`, 409);
  const identity = checked.outcome === 'new' || checked.outcome === 'removed' ? (checked.identity ?? null) : null;
  const record = deps.catalog.add({ typeId: type.id, name: input.name.trim() || type.meta.name, identity, config: deviceConfig, description: type.describe(deviceConfig) });
  return { record, kind: 'device.added' };
}

/** The write itself. Run it in one transaction: a device saved without its connection could never be reached. */
export function writeSaved(deps: SaveDeps, draft: Draft, input: SaveRequest, config: { device: ConfigValues; connection: ConfigValues }): { record: DeviceRecord; kind: string } {
  const method = draft.method!;
  const address = draft.address!;
  const { record, kind } = deviceFor(deps, draft, input, config.device);

  // An exclusive address belongs to one device.
  if (draft.reach.exclusive && draft.heldBy === null) {
    const claim = deps.connections.claimant(method.transport, address);
    if (claim && claim.deviceId !== record.id) throw new SetupError('Another device you have is already reached at that address', 409);
  }

  const saved = deps.connections.add({ deviceId: record.id, method: method.id, transport: method.transport, heldBy: draft.heldBy, address, config: config.connection });
  if (draft.secrets.size) deps.connections.setSecrets(saved.id, Object.fromEntries(draft.secrets));

  for (const link of input.links ?? []) {
    if (!isLinkKind(link.kind)) throw new SetupError(`There is no link called "${link.kind}"`);
    const other = deps.catalog.active(savedDeviceId(link.other.device));
    if (!other) throw new SetupError('The device to link to has gone', 404);
    const mine = { device: record.id, part: link.part, description: record.description };
    const theirs = { device: other.id, part: link.other.part, description: other.description };
    const [source, target] = link.role === 'source' ? [mine, theirs] : [theirs, mine];
    if (!linkFits(link.kind, source.description, source.part, target.description, target.part)) throw new SetupError(`"${linkKindSpec(link.kind).verb}" does not fit those two parts`);
    deps.links.add({ kind: link.kind, source: { device: source.device, part: source.part }, target: { device: target.device, part: target.part } });
  }
  return { record, kind };
}
