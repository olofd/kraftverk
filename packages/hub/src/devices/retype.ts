import {
  capabilitiesOf,
  convert,
  convertible,
  linkFits,
  linkKindSpec,
  MAIN_PART,
  partOf,
  partsOf,
  unitIn,
  type AttributeSpec,
  type DeviceDescription,
  type LinkKind,
  type Part,
  type Unit,
} from '@kraftverk/device-sdk';
import type { MoveView } from '@kraftverk/api-contract';
import type { AutomationStore, ConnectionStore, DeviceCatalog, DeviceRecord, HistoryStore, LinkStore } from '@kraftverk/store';

/*
  A device changing what it is (docs/PLAN-ZIGBEE.md §2.1): the same thing,
  reached as another type — a plug once behind one vendor's gateway, now
  behind another's coordinator — keeping its history, its links and the automations
  that use it. Its old description is mapped onto the new one, part by part
  and attribute by attribute, and a person sees the mapping before anything
  moves. Nothing is mapped by guesswork a person cannot read back: by
  meaning, then by key, then by label, each on the part it maps to.
*/

/** Where one attribute's history goes: to a key of the new description, or nowhere (kept where it is). */
type AttributeMove = {
  from: AttributeSpec;
  to: AttributeSpec | null;
  how: 'meaning' | 'key' | 'label' | null;
  /** For a number in another unit of the same dimension: how its kept values are converted. */
  scale: { factor: number; offset: number } | null;
};

/** The whole mapping: parts, then attributes on them. */
type RetypePlan = {
  parts: Map<string, string | null>;
  attributes: AttributeMove[];
};

/** How alike two parts are: the capabilities both offer, their kind, their id. Zero: not alike at all. */
function partLikeness(from: DeviceDescription, fromPart: Part, to: DeviceDescription, toPart: Part): number {
  const theirs = new Set(capabilitiesOf(to, toPart.id));
  const shared = capabilitiesOf(from, fromPart.id).filter((capability) => theirs.has(capability)).length;
  return shared * 10 + (fromPart.kind === toPart.kind ? 3 : 0) + (fromPart.id === toPart.id ? 2 : 0);
}

/** Each old part to the new part most like it, each new part taken once; `main` is always `main`. */
function mapParts(from: DeviceDescription, had: readonly AttributeSpec[], to: DeviceDescription): Map<string, string | null> {
  const known = partsOf(from);
  // Parts it had attributes on, though its description no longer names them: a pack unplugged.
  for (const attribute of had) {
    const id = partOf(attribute);
    if (!known.some((part) => part.id === id)) known.push({ id, label: id, kind: 'other' });
  }
  const targets = partsOf(to);
  /*
    `main` is `main` — unless what it did is done by another part now: a plug
    that switched as a whole becomes the outlet that switches, so the
    automations and links that switched it still do.
  */
  const mainDid = capabilitiesOf(from, MAIN_PART);
  const mainDoes = new Set(capabilitiesOf(to, MAIN_PART));
  const moved = mainDid.some((capability) => !mainDoes.has(capability))
    ? targets
        .filter((target) => target.id !== MAIN_PART)
        .map((target) => ({ target, score: partLikeness(from, partsOf(from).find((part) => part.id === MAIN_PART)!, to, target) }))
        .filter(({ score }) => score >= 10)
        .sort((a, b) => b.score - a.score)[0]?.target.id
    : undefined;
  const parts = new Map<string, string | null>([[MAIN_PART, moved ?? MAIN_PART]]);
  const taken = new Set<string>([moved ?? MAIN_PART]);
  const pairs = known
    .filter((part) => part.id !== MAIN_PART)
    .flatMap((part) => targets.filter((target) => target.id !== MAIN_PART).map((target) => ({ part, target, score: partLikeness(from, part, to, target) })))
    .filter((pair) => pair.score > 0)
    .sort((a, b) => b.score - a.score);
  for (const { part, target } of pairs) {
    if (parts.has(part.id) || taken.has(target.id)) continue;
    parts.set(part.id, target.id);
    taken.add(target.id);
  }
  for (const part of known) if (!parts.has(part.id)) parts.set(part.id, null);
  return parts;
}

/** The scale a number's kept values take to the new attribute's unit, or null when no conversion is needed; undefined when they cannot meet. */
function scaleBetween(from: AttributeSpec, to: AttributeSpec): AttributeMove['scale'] | undefined {
  if (from.value.type !== to.value.type) return undefined;
  if (from.value.type !== 'number') return null;
  const a = unitIn(from);
  const b = unitIn(to);
  if (a === b) return null;
  if (!a || !b || !convertible(a as Unit, b as Unit)) return undefined;
  const zero = convert(0, a as Unit, b as Unit)!;
  return { factor: convert(1, a as Unit, b as Unit)! - zero, offset: zero };
}

/**
 * The mapping from what a device was to what it is to be: each part to the
 * one most like it, each attribute it has ever had to one of the new
 * description's — by meaning on the part it maps to, then by the same key,
 * then by the same label — of a value its history can be read as. One
 * that maps nowhere keeps its history where it is.
 */
export function planRetype(had: readonly AttributeSpec[], from: DeviceDescription, to: DeviceDescription): RetypePlan {
  const parts = mapParts(from, had, to);
  const taken = new Set<string>();
  const fits = (attribute: AttributeSpec, candidate: AttributeSpec) => !taken.has(candidate.key) && scaleBetween(attribute, candidate) !== undefined;
  const onPart = (attribute: AttributeSpec) => {
    const part = parts.get(partOf(attribute));
    return part ? to.attributes.filter((candidate) => partOf(candidate) === part) : [];
  };

  const attributes = had.map((attribute): AttributeMove => {
    const tries: [AttributeMove['how'], (candidate: AttributeSpec) => boolean][] = [
      ['meaning', (candidate) => attribute.means !== undefined && candidate.means === attribute.means],
      ['key', (candidate) => candidate.key === attribute.key],
      ['label', (candidate) => candidate.label.toLowerCase() === attribute.label.toLowerCase()],
    ];
    for (const [how, same] of tries) {
      // On the part it maps to first; anywhere else only when it is the only one.
      const near = onPart(attribute).find((candidate) => same(candidate) && fits(attribute, candidate));
      const anywhere = to.attributes.filter((candidate) => same(candidate) && fits(attribute, candidate));
      const found = near ?? (anywhere.length === 1 ? anywhere[0] : undefined);
      if (found) {
        taken.add(found.key);
        return { from: attribute, to: found, how, scale: scaleBetween(attribute, found) ?? null };
      }
    }
    return { from: attribute, to: null, how: null, scale: null };
  });
  return { parts, attributes };
}

export type RetypeDeps = {
  catalog: DeviceCatalog;
  connections: ConnectionStore;
  links: LinkStore;
  automations: AutomationStore;
  history: HistoryStore;
};

/** What a device moving to another type means for it, as a person reads it before saying yes. */
export function moveView(
  deps: RetypeDeps,
  device: DeviceRecord,
  from: { typeId: string; name: string },
  to: { typeId: string; name: string; description: DeviceDescription; methods: readonly string[] }
): MoveView {
  const plan = planRetype(deps.catalog.attributes(device.id), device.description, to.description);
  const newParts = partsOf(to.description);
  const oldParts = partsOf(device.description);
  const labelOf = (id: string, parts: readonly Part[]) => parts.find((part) => part.id === id)?.label ?? id;
  return {
    device: { id: device.id, name: device.name },
    from: { typeId: from.typeId, name: from.name },
    to: { typeId: to.typeId, name: to.name },
    attributes: plan.attributes.map((move) => ({ key: move.from.key, label: move.from.label, to: move.to?.key ?? null, toLabel: move.to?.label ?? null, how: move.how })),
    parts: [...plan.parts].map(([id, target]) => ({ id, label: labelOf(id, oldParts), to: target, toLabel: target ? labelOf(target, newParts) : null })),
    links: linkFates(deps, device, plan, to.description).map(({ id, summary, kept }) => ({ id, summary, kept })),
    automations: deps.automations.usingDevice(device.id).map((automation) => ({
      id: automation.id,
      name: automation.name,
      kept: [...Object.values(automation.roles), ...Object.values(automation.groups).flat()].every((binding) => binding.device !== device.id || plan.parts.get(binding.part) != null),
    })),
    connectionsRemoved: deps.connections
      .forDevice(device.id)
      .filter((connection) => !to.methods.includes(connection.method))
      .map((connection) => ({ id: connection.id, label: connection.method })),
  };
}

/** Each link of the device: re-pointed to the part its end becomes, when that part still offers what the link's kind needs; else removed. */
function linkFates(deps: Pick<RetypeDeps, 'links' | 'catalog'>, device: DeviceRecord, plan: RetypePlan, description: DeviceDescription) {
  return deps.links.forDevice(device.id).map((link) => {
    const mine: 'source' | 'target' = link.source.device === device.id ? 'source' : 'target';
    const part = plan.parts.get(link[mine].part) ?? null;
    const other = deps.catalog.active(link[mine === 'source' ? 'target' : 'source'].device);
    const spec = linkKindSpec(link.kind as LinkKind);
    const fits =
      part !== null &&
      other !== null &&
      (mine === 'source'
        ? linkFits(link.kind as LinkKind, description, part, other.description, link.target.part)
        : linkFits(link.kind as LinkKind, other.description, link.source.part, description, part));
    const otherName = other?.name ?? 'a removed device';
    return {
      id: link.id,
      end: mine,
      part,
      kept: fits,
      summary: fits ? `It still ${spec.verb} ${mine === 'source' ? otherName : `from ${otherName}`}` : `Its "${spec.verb}" link with ${otherName} goes: nothing it becomes can be that end`,
    };
  });
}

/**
 * Moves a device to another type, as `moveView` said: its history re-keyed
 * (converted where a unit changed), what it became recorded, its links and
 * automations re-pointed, the ways its new type has none for removed, and
 * what its old type kept for it cleared. Run inside the save's transaction.
 */
export function retype(
  deps: RetypeDeps,
  device: DeviceRecord,
  to: { typeId: string; description: DeviceDescription; config: Record<string, unknown>; methods: readonly string[] }
): void {
  const had = deps.catalog.attributes(device.id);
  const plan = planRetype(had, device.description, to.description);
  const moves = plan.attributes.flatMap((move) => (move.to && (move.to.key !== move.from.key || move.scale || partOf(move.to) !== partOf(move.from)) ? [{ from: move.from.key, to: move.to.key, part: partOf(move.to), scale: move.scale }] : []));
  /*
    One that maps nowhere keeps its history — but not under a key the new
    description, or another moving here, has: its values would be read as
    that one's, and the two merge where they share a minute. It is set
    aside under a key of its own, and keeps its label.
  */
  const used = new Set([...had.map((attribute) => attribute.key), ...to.description.attributes.map((attribute) => attribute.key)]);
  for (const move of plan.attributes) {
    if (move.to || !(to.description.attributes.some((attribute) => attribute.key === move.from.key) || moves.some((other) => other.to === move.from.key))) continue;
    let aside = `${move.from.key}~was`;
    for (let n = 2; used.has(aside); n++) aside = `${move.from.key}~was${n}`;
    used.add(aside);
    moves.push({ from: move.from.key, to: aside, part: partOf(move.from), scale: null });
  }
  deps.history.rekey(device.id, moves);
  deps.catalog.retype(device.id, { typeId: to.typeId, description: to.description, config: to.config, keys: moves.map(({ from, to: key, part }) => ({ from, to: key, part })) });

  for (const fate of linkFates(deps, device, plan, to.description)) {
    if (fate.kept && fate.part) deps.links.repoint(fate.id, fate.end, fate.part);
    else deps.links.remove(fate.id);
  }
  /*
    A part that maps nowhere keeps its id, so the automations bound to it
    say they need attention — unless another part moves to that id: then
    they would switch that one instead. It is set aside, and still says so.
  */
  const targets = new Set([...plan.parts.values()].filter((part): part is string => part !== null));
  deps.automations.repointParts(device.id, new Map([...plan.parts].map(([from, part]) => [from, part ?? (targets.has(from) ? `${from}~gone` : null)])));
  for (const connection of deps.connections.forDevice(device.id)) {
    if (!to.methods.includes(connection.method)) deps.connections.remove(connection.id);
  }
}
