import type { CheckOutcome } from '@kraftverk/api-contract';
import { coversModel, modelCloseness, type Identified, type TypeDeclaration, type SavedDeviceId } from '@kraftverk/device-sdk';

/**
 * What a device's answer to the check step means, against the devices you
 * have (docs/DATA-MODEL.md §1): another model, already yours, yours before,
 * or new. The same judgement wherever the check ran — on the server against
 * its catalog, in the app against its own.
 */

export type KnownDevices = {
  /** The device with this identity now, and the removed ones that had it. */
  byIdentity(identity: string): {
    active: { id: SavedDeviceId; name: string } | null;
    removed: readonly { id: SavedDeviceId; name: string; removedAt: string }[];
  };
};

export function judgeCheck(
  identified: Identified,
  context: {
    type: TypeDeclaration;
    /** Every installed type: which one covers a model this one does not. */
    types: Iterable<TypeDeclaration>;
    known: KnownDevices;
    /** An identity the setup already knew — from the sighting that was chosen — when the device itself did not say. */
    identityHint?: string | null;
  }
): CheckOutcome {
  const { type } = context;
  // A model this type does not cover, which another installed type may — the one naming it most closely.
  const models = type.meta.models ?? [];
  if (identified.model && models.length && !models.some((model) => coversModel(model, identified.model!))) {
    const closeness = (candidate: TypeDeclaration) => modelCloseness(candidate.meta.models, identified.model!);
    const other = [...context.types].filter((candidate) => closeness(candidate) > 0).sort((a, b) => closeness(b) - closeness(a))[0];
    return {
      outcome: 'other-model',
      summary: `This is a ${identified.model}, not a ${type.meta.name}.`,
      model: identified.model,
      type: other ? { id: other.id, name: other.meta.name } : null,
    };
  }

  const identity = identified.identity ?? context.identityHint ?? null;
  if (identity) {
    const known = context.known.byIdentity(identity);
    if (known.active) {
      return { outcome: 'yours', summary: `This is your ${known.active.name}. ${identified.summary}`, device: { id: known.active.id, name: known.active.name }, move: null };
    }
    if (known.removed.length) {
      return {
        outcome: 'removed',
        summary: `You had this before. ${identified.summary}`,
        identity,
        devices: known.removed.map((device) => ({ id: device.id, name: device.name, removedAt: device.removedAt })),
      };
    }
  }
  return { outcome: 'new', summary: identified.summary, identity };
}
