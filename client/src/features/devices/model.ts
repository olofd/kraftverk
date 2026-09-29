import type { AttributeSpec, ConfigSchema, DeviceDescription, LinkView } from '@kraftverk/api-client';
import { attributeMeaning, capabilitiesOf, capabilityIn, partsOf, settingField, type CapabilityId, type ConfigField, type Part } from '@kraftverk/device-sdk';

/**
 * What the generic panels draw, decided from the description alone: which
 * switches, which settings forms, what feeds what. Pure, so each is tested
 * without rendering a screen — the panels are these, drawn.
 */

/** One switch a part takes: which command, which argument, and the on/off attribute it moves. */
export type Toggle = { part: Part; capability: CapabilityId; command: string; argument: string; attribute: AttributeSpec };

/**
 * Every on/off a device's parts can be switched through: each command a part's
 * capability takes whose argument sets an on/off attribute it reports.
 */
export function togglesOf(description: DeviceDescription, name?: string): Toggle[] {
  return partsOf(description, name).flatMap((part) =>
    capabilitiesOf(description, part.id).flatMap((capability) =>
      Object.entries(capabilityIn(description, capability)?.commands ?? {}).flatMap(([command, spec]) =>
        Object.entries(spec.sets).flatMap(([argument, attributeName]) => {
          const means = capabilityIn(description, capability)?.attributes[attributeName]?.means;
          const attribute = means ? attributeMeaning(description, part.id, means) : null;
          return attribute && attribute.value.type === 'boolean' && spec.args[argument]?.type === 'boolean' ? [{ part, capability, command, argument, attribute }] : [];
        })
      )
    )
  );
}

/** The attributes a device can be told, as the form language draws them: one form per section, in the order they are declared. */
export function settingsForms(description: DeviceDescription): { section: string; schema: ConfigSchema; keys: string[] }[] {
  const writable = description.attributes.filter((attribute) => attribute.access === 'write');
  const sections = [...new Set(writable.map((attribute) => attribute.section ?? 'Settings'))];
  return sections.map((section) => {
    const inSection = writable.filter((attribute) => (attribute.section ?? 'Settings') === section);
    return {
      section,
      keys: inSection.map((attribute) => attribute.key),
      schema: {
        fields: Object.fromEntries(
          inSection.flatMap((attribute): [string, ConfigField][] => {
            const field = settingField(attribute);
            return field ? [[attribute.key, field]] : [];
          })
        ),
      },
    };
  });
}

const endName = (link: LinkView) => (link.other.partLabel ? `${link.other.name} — ${link.other.partLabel}` : link.other.name);

/** What feeds each of a device's parts, by the part's id, from the links it is the target of. */
export const fedBy = (links: readonly LinkView[]): Record<string, string> => Object.fromEntries(links.filter((link) => link.role === 'target').map((link) => [link.part, endName(link)]));

/** What each of a device's parts feeds, by the part's id, from the links it is the source of. */
export const feedsTo = (links: readonly LinkView[]): Record<string, string> => Object.fromEntries(links.filter((link) => link.role === 'source').map((link) => [link.part, endName(link)]));
