import { BRIDGE_TRANSPORT, modelCloseness, type BridgeHost, type DeviceType, type Member, type SavedDeviceId } from '@kraftverk/device-sdk';
import type { SessionManager } from '@kraftverk/holder';
import type { ConnectionStore, DeviceCatalog } from '@kraftverk/store';

import type { DeviceTypeRegistry } from '../installed/types.ts';

/*
  The devices behind the bridges open here (docs/PLAN-INTEGRATIONS.md §4.3):
  live, never stored, each a sighting until a device claims it — what setup
  offers to choose from, and "found near you" offers to add.
*/

/** A type that could be a member, and its way through the bridge. */
type MemberType = { type: DeviceType<any>; methodId: string };

/** A bridge open here, by its device. */
export type OpenBridge = { id: SavedDeviceId; name: string; typeId: string; host: BridgeHost };

/** One member of an open bridge: which bridge, what it says, the device that already is it, and the types that could be it. */
export type MemberOffer = {
  bridge: OpenBridge;
  member: Member;
  claimedBy: { id: SavedDeviceId; name: string } | null;
  types: MemberType[];
};

type Deps = { types: DeviceTypeRegistry; sessions: SessionManager; catalog: DeviceCatalog; connections: ConnectionStore };

/** Every bridge open here, of these types when some are given. */
export function openBridges(deps: Pick<Deps, 'sessions' | 'catalog'>, typeIds?: readonly string[]): OpenBridge[] {
  return deps.sessions.opened().flatMap((id) => {
    const host = deps.sessions.get(id)?.bridge;
    const record = deps.catalog.active(id);
    if (!host || !record || (typeIds && !typeIds.includes(record.typeId))) return [];
    return [{ id, name: record.name, typeId: record.typeId, host }];
  });
}

/** Every type with a way through a bridge of this type, and that way. */
function typesThrough(types: DeviceTypeRegistry, bridgeTypeId: string): MemberType[] {
  return types.all().flatMap((type) => {
    const method = type.connections.find((candidate) => candidate.transport === BRIDGE_TRANSPORT && candidate.through?.includes(bridgeTypeId));
    return method ? [{ type, methodId: method.id }] : [];
  });
}

/**
 * The types a member could be: the one its bridge says, when it is
 * installed and goes through it; else those whose models cover the one it
 * reports, the closest first; else the bridge's fallback, the platform's
 * generic one. None: nothing here knows it.
 */
function typesFor(member: Member, candidates: readonly MemberType[], fallback: string | undefined): MemberType[] {
  const named = member.typeId ? candidates.filter((candidate) => candidate.type.id === member.typeId) : [];
  if (named.length) return named;
  const claiming = member.model
    ? candidates
        .map((candidate) => ({ candidate, closeness: modelCloseness(candidate.type.meta.models, member.model!) }))
        .filter(({ closeness }) => closeness > 0)
        .sort((a, b) => b.closeness - a.closeness)
        .map(({ candidate }) => candidate)
    : [];
  if (claiming.length) return claiming;
  return candidates.filter((candidate) => candidate.type.id === fallback);
}

/** Every member of every bridge open here, of these bridge types when some are given. */
export function membersOnOffer(deps: Deps, bridgeTypeIds?: readonly string[]): MemberOffer[] {
  return openBridges(deps, bridgeTypeIds).flatMap((bridge) => {
    const candidates = typesThrough(deps.types, bridge.typeId);
    const fallback = deps.types.get(bridge.typeId)?.bridge?.fallback;
    return bridge.host.members().map((member) => {
      const claim = deps.connections.member(bridge.id, member.key);
      const claimed = claim ? deps.catalog.active(claim.deviceId) : null;
      return { bridge, member, claimedBy: claimed ? { id: claimed.id, name: claimed.name } : null, types: typesFor(member, candidates, fallback) };
    });
  });
}
