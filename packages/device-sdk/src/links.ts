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
