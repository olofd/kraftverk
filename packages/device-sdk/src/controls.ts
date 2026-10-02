import type { CapabilityId } from './capabilities.ts';
import { attributeMeaning, capabilitiesOf, capabilityIn, partsOf, settingField, type AttributeSpec, type DeviceDescription, type Part } from './description.ts';
import type { ConfigField, ConfigSchema } from './schema.ts';

/**
 * What a device can be switched and told, decided from its description alone:
 * which on/offs, which settings forms. What any screen draws for a device
 * nobody wrote one for — the app's generic panels — and pure, so each is
 * tested without one.
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
