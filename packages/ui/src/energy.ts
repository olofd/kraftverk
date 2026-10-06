import { attributesOf, partsOf, quantityOf, type AttributeSpec, type DeviceDescription, type EnergyRole, type Part, type Reading } from '@kraftverk/device-sdk';

/**
 * The flow of energy through a device, from its description alone: every part
 * with an energy role is a node, its power the reading of the attribute that
 * measures it, and a storage part's charge its `charge`. Nothing here
 * knows a station from an inverter or a battery wall — a part says what it is
 * in the flow, and the flow is drawn.
 *
 * Deliberately free of React, so it is tested on its own.
 */

export type FlowNode = {
  part: Part;
  /** Its power now, in watts: what a source gives, what a load draws. Null when it reports none, or has not said, and for storage. */
  watts: number | null;
  /** A storage part's charge, in percent. */
  soc: number | null;
};

export type Flow = Record<EnergyRole, FlowNode[]>;

const reading = (readings: readonly Reading[], attribute: AttributeSpec | undefined): number | null => {
  const found = attribute ? readings.find((candidate) => candidate.key === attribute.key)?.value : null;
  return typeof found === 'number' ? found : null;
};

/** Which of a part's attributes says how much power goes through it, for its role: what it gives, draws or holds. */
function powerOf(attributes: readonly AttributeSpec[], role: 'source' | 'load'): AttributeSpec | undefined {
  const power = attributes.filter((attribute) => quantityOf(attribute) === 'power');
  const prefer = role === 'load' ? ['power', 'output'] : ['input', 'power'];
  return power.find((attribute) => prefer.some((means) => attribute.means?.startsWith(means))) ?? power[0];
}

/** The device's flow, or null when none of its parts has a place in one. */
export function energyFlowOf(description: DeviceDescription, readings: readonly Reading[], mainLabel?: string): Flow | null {
  const flow: Flow = { source: [], storage: [], load: [] };
  for (const part of partsOf(description, mainLabel)) {
    const role = part.energy?.role;
    if (!role) continue;
    const attributes = attributesOf(description, part.id);
    flow[role].push({
      part,
      watts: role === 'storage' ? null : reading(readings, powerOf(attributes, role)),
      soc: role === 'storage' ? reading(readings, attributes.find((attribute) => attribute.means === 'charge')) : null,
    });
  }
  return flow.source.length + flow.storage.length + flow.load.length > 0 ? flow : null;
}
