import type { CapabilityName } from './capabilities.ts';
import { capabilitiesOf, MAIN_PART, partsOf, type DeviceDescription } from './description.ts';
import type { StandardMeaningId } from './meanings.ts';

/**
 * Links: physical facts between two devices, recorded by the user
 * (docs/ARCHITECTURE.md §4.4).
 *
 * *This plug's output feeds that station's AC input* is a fact about the house,
 * not about either device, and not something one automation should keep to
 * itself: the gateway verifies against it, the energy view draws it, and any
 * number of automations use it. So it is stored once, as a link.
 *
 * A link kind says which capability each end must offer, so a link can only be
 * made between devices it makes sense for. The library is small and grows one
 * reviewed kind at a time, like the capabilities.
 */

export type LinkKindSpec = {
  /** In a sentence: "feeds". */
  verb: string;
  from: CapabilityName;
  to: CapabilityName;
  /** What it means, for the screen that sets it. */
  description: string;
  /** Asked while adding the source: "What is plugged into this plug?" */
  question: { fromSide: string; toSide: string };
  /** One source may have at most one target of this kind. */
  onePerSource: boolean;
  /**
   * What the target part reads that switching the source should change — the
   * second proof, after the source's own readback, that a command did
   * something physical. A station that a plug feeds sees its mains come and go.
   */
  evidence: StandardMeaningId;
};

export const LINK_KINDS = {
  feeds: {
    verb: 'feeds',
    from: 'switch',
    to: 'acInput',
    description:
      'Switching the source switches the target’s mains. Kraftverk checks the target sees mains come and go whenever the source is switched.',
    question: {
      fromSide: 'What is plugged into this plug?',
      toSide: 'Is it charged through a smart plug?',
    },
    onePerSource: true,
    evidence: 'grid.present',
  },
} as const satisfies Record<string, LinkKindSpec>;

export type LinkKind = keyof typeof LINK_KINDS;

export const LINK_KIND_IDS = Object.keys(LINK_KINDS) as LinkKind[];

export const isLinkKind = (id: string): id is LinkKind => Object.hasOwn(LINK_KINDS, id);

/** Whether a device offering `from` may be linked to one offering `to` by `kind`. */
/**
 * Whether one device may be linked to another by `kind`: the source's main
 * part offers what the link switches — a plug's relay — and some part of the
 * target offers what it reaches, a station's AC input.
 */
export const linkFits = (kind: LinkKind, source: DeviceDescription, target: DeviceDescription): boolean =>
  capabilitiesOf(source, MAIN_PART).includes(LINK_KINDS[kind].from) &&
  partsOf(target).some((part) => capabilitiesOf(target, part.id).includes(LINK_KINDS[kind].to));
