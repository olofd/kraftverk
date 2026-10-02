import type { CapabilityName } from './capabilities.ts';
import { capabilitiesOf, partsOf, type DeviceDescription, type Part } from './description.ts';
import type { StandardMeaningId } from './meanings.ts';

/**
 * Links: physical facts between parts of two devices, recorded by the user
 * (docs/ARCHITECTURE.md §4.4).
 *
 * *This plug's output feeds that station's AC input* is a fact about the house,
 * not about either device, and not something one automation should keep to
 * itself: the gateway verifies against it, the energy view draws it, and any
 * number of automations use it. So it is stored once, as a link — between
 * parts, because a station's AC outlet can feed something just as a plug can,
 * and a station has one mains input among its parts.
 *
 * A link kind says which capability each end must offer, what the target
 * reads that proves a command on the source did something, and whether being
 * its source makes a command consequential. The gateway walks every kind by
 * these declarations and names none. The library is small and grows one
 * reviewed kind at a time, with the first device that needs it, like the
 * capabilities.
 */

export type LinkKindSpec = {
  /** In a sentence: "feeds". */
  verb: string;
  /** What the source part offers: what a command on it goes through. */
  from: CapabilityName;
  /** What the target part offers: what the link reaches. */
  to: CapabilityName;
  /** What it means, for the screen that sets it. */
  description: string;
  /** Asked while adding the source, and the target. */
  question: { fromSide: string; toSide: string };
  /**
   * What switching the source off does to the target, said beside the
   * source's switch only when this link is there — `{target}` is the
   * target's name: a plug that feeds a station warns of it; one the station
   * feeds does not.
   */
  whenSourceOff: string;
  /** One source part may have at most one target of this kind. */
  onePerSource: boolean;
  /**
   * The second proof, after the source's own readback, that a command did
   * something physical: the target's `means` should come to equal the source's
   * `follows` — a station that a plug feeds sees its mains come and go as the
   * plug's relay does.
   */
  evidence: { means: StandardMeaningId; follows: StandardMeaningId };
  /**
   * Being the source makes a consequential command need confirming — cutting
   * what feeds a device — and the first command through a new link too, so a
   * person sees it is the right part before it matters.
   */
  consequential: boolean;
};

export const LINK_KINDS = {
  feeds: {
    verb: 'feeds',
    from: 'switch',
    to: 'acInput',
    description:
      'Switching the source switches the target’s mains. Kraftverk checks the target sees mains come and go whenever the source is switched.',
    question: {
      fromSide: 'What is plugged into this?',
      toSide: 'Is it charged through something that switches?',
    },
    whenSourceOff: 'It feeds {target}, which loses its mains while this is off.',
    onePerSource: true,
    evidence: { means: 'grid.present', follows: 'switch.on' },
    consequential: true,
  },
} as const satisfies Record<string, LinkKindSpec>;

export type LinkKind = keyof typeof LINK_KINDS;

export const LINK_KIND_IDS = Object.keys(LINK_KINDS) as LinkKind[];

export const isLinkKind = (id: string): id is LinkKind => Object.hasOwn(LINK_KINDS, id);

export const linkKindSpec = (kind: LinkKind): LinkKindSpec => LINK_KINDS[kind];

/** One end of a link: a part of a device. */
export type LinkEnd<Device = string> = { device: Device; part: string };

/**
 * What switching a part off does, said beside its switch: its own
 * consequence, and what each link it is the source of adds — "It feeds
 * Garage station — Mains, which loses its mains while this is off". Nothing
 * a link does not show.
 */
export function switchConsequence(own: string | undefined, sourceOf: readonly { kind: LinkKind; target: string }[]): string | undefined {
  const said = [own, ...sourceOf.map((link) => LINK_KINDS[link.kind].whenSourceOff.split('{target}').join(link.target))].filter(Boolean);
  return said.length ? said.join(' ') : undefined;
}

/** Whether one part may be linked to another by `kind`: the source offers what the link goes through, the target what it reaches. */
export const linkFits = (kind: LinkKind, source: DeviceDescription, sourcePart: string, target: DeviceDescription, targetPart: string): boolean =>
  capabilitiesOf(source, sourcePart).includes(LINK_KINDS[kind].from) && capabilitiesOf(target, targetPart).includes(LINK_KINDS[kind].to);

/** The parts of a device that can be a link's source, or its target, by `kind`. */
export const linkableParts = (kind: LinkKind, description: DeviceDescription, side: 'source' | 'target'): Part[] =>
  partsOf(description).filter((part) => capabilitiesOf(description, part.id).includes(side === 'source' ? LINK_KINDS[kind].from : LINK_KINDS[kind].to));

/** Every way two devices can be linked by `kind`, this one as the source: each source part with each target part. */
export const linkCandidates = (
  kind: LinkKind,
  source: DeviceDescription,
  target: DeviceDescription
): { sourcePart: Part; targetPart: Part }[] =>
  linkableParts(kind, source, 'source').flatMap((sourcePart) => linkableParts(kind, target, 'target').map((targetPart) => ({ sourcePart, targetPart })));

/** One way a device could be linked: by which kind, which end it is, its part, and which part of which other device. */
export type LinkOffer<D> = { kind: LinkKind; role: 'source' | 'target'; part: Part; other: D; otherPart: Part };

/**
 * Every link the SDK's rule would accept between a device's parts and the
 * parts of others, whichever end it is: what the app offers, so only what
 * the home would accept is offered.
 */
export const linkOffers = <D extends { description: DeviceDescription }>(description: DeviceDescription, others: readonly D[]): LinkOffer<D>[] =>
  LINK_KIND_IDS.flatMap((kind) =>
    others.flatMap((other) => [
      ...linkCandidates(kind, description, other.description).map(({ sourcePart, targetPart }) => ({ kind, role: 'source' as const, part: sourcePart, other, otherPart: targetPart })),
      ...linkCandidates(kind, other.description, description).map(({ sourcePart, targetPart }) => ({ kind, role: 'target' as const, part: targetPart, other, otherPart: sourcePart })),
    ])
  );
