import type { DeviceView, VocabularyView, WorldDevice, WorldView } from '@kraftverk/api-contract';
import {
  attributesOf,
  capabilitiesOf,
  CAPABILITIES,
  isCurrent,
  LINK_KINDS,
  partsOf,
  POLICY_VALUES,
  STANDARD_MEANINGS,
  type CapabilitySpec,
  type PolicyValues,
} from '@kraftverk/device-sdk';
import { isAutomationRole, isGroupRole } from '@kraftverk/automation';

import type { AutomationLibrary } from '@kraftverk/automation-engine';

/**
 * The house as a model reads it (PROPOSITION.md §5.1): not entities, but
 * devices of parts, each with what it offers and what it reports, how fresh,
 * and how the parts are joined. Small enough for a local model's context, and
 * in a stable order so two snapshots can be compared line by line.
 */

/** What an assistant may do, as the gateway will hold it to: said once, where it reads the world. */
export const AGENT_RULES = [
  'Every command goes through the gateway: it checks the arguments, the dwell time, that readings are current, and reads back what it did.',
  'A command that needs a person’s confirmation — turning off a load, cutting what feeds a station — is refused to an assistant: say what you would do and let the person do it in the app.',
  'A setting that can damage the hardware is never changed by an assistant.',
  'An automation you propose only watches until a person lets it act: rehearse it, and say what it would have done.',
  'A sequence a person set up to be started when asked — "start charging the scooter" — you may start for them: say what its steps are first, then follow it with `automations` until it ends, and say how it went.',
  'A value that is not current is not known now: do not act on it; say it is stale.',
];

export function worldOf(devices: readonly DeviceView[], options: { readOnly: boolean; now?: number }): WorldView {
  const now = options.now ?? Date.now();
  const world: WorldDevice[] = [...devices]
    .filter((device) => !device.removedAt)
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    .map((device) => ({
      id: device.id,
      name: device.name,
      type: device.meta.name,
      kind: device.kind,
      status: device.health.status,
      detail: device.health.detail,
      parts: partsOf(device.description, device.name).map((part) => ({
        id: part.id,
        label: part.label,
        kind: part.kind,
        capabilities: capabilitiesOf(device.description, part.id),
        values: attributesOf(device.description, part.id)
          // What it reports, not what it can be told, nor its diagnostics: those are asked for.
          .filter((attribute) => attribute.access !== 'write' && attribute.category !== 'diagnostic')
          .map((attribute) => {
            const reading = device.readings.find((candidate) => candidate.key === attribute.key);
            const age = reading?.at ? Math.max(0, Math.round((now - Date.parse(reading.at)) / 1000)) : null;
            return {
              key: attribute.key,
              label: attribute.label,
              means: attribute.means ?? null,
              value: reading?.value ?? null,
              unit: attribute.value.type === 'number' ? (attribute.value.unit ?? null) : null,
              age,
              current: reading ? isCurrent(attribute, reading, now) : false,
            };
          }),
      })),
      links: device.links.map((link) => ({ kind: link.kind, part: link.part, role: link.role, device: link.other.id, name: link.other.name, otherPart: link.other.part })),
    }));
  return { at: new Date(now).toISOString(), readOnly: options.readOnly, rules: AGENT_RULES, devices: world };
}

const shown = (value: WorldDevice['parts'][number]['values'][number]): string => {
  if (value.value === null) return '?';
  const text = value.value === true ? 'on' : value.value === false ? 'off' : typeof value.value === 'number' ? String(Math.round(value.value * 10) / 10) : String(value.value);
  return `${text}${value.unit ? ` ${value.unit}` : ''}${value.current ? '' : ` (stale, ${value.age === null ? 'never read' : `${value.age} s old`})`}`;
};

/** The same world in a few lines a device: what a context window wants. */
export function worldText(world: WorldView): string {
  const lines = [`The house at ${world.at}${world.readOnly ? ' (read-only: every write is refused)' : ''}.`, ...world.rules.map((rule) => `- ${rule}`), ''];
  for (const device of world.devices) {
    lines.push(`${device.name} [${device.id}] ${device.type}: ${device.status}${device.status === 'connected' ? '' : ` (${device.detail})`}`);
    for (const part of device.parts) {
      const values = part.values.map((value) => `${value.label} ${shown(value)}${value.means ? ` <${value.means}>` : ''}`).join(', ');
      lines.push(`  ${part.id} "${part.label}" ${part.kind}${part.capabilities.length ? ` offers ${part.capabilities.join(', ')}` : ''}${values ? `: ${values}` : ''}`);
    }
    for (const link of device.links) {
      lines.push(link.role === 'source' ? `  ${link.part} ${link.kind} ${link.name} [${link.device}] ${link.otherPart}` : `  ${link.part} is fed (${link.kind}) by ${link.name} [${link.device}] ${link.otherPart}`);
    }
  }
  return lines.join('\n');
}

const capabilityWords = (spec: CapabilitySpec) => ({
  label: spec.label,
  attributes: Object.fromEntries(Object.entries(spec.attributes).map(([name, attribute]) => [name, attribute.means])),
  commands: Object.fromEntries(Object.entries(spec.commands).map(([name, command]) => [name, { description: command.description, args: command.args, consequential: command.consequential ?? null }])),
  queries: Object.fromEntries(Object.entries(spec.queries).map(([name, query]) => [name, { description: query.description, args: query.args }])),
});

/** The words the world is said in, from the SDK and what is installed. */
export function vocabularyOf(library: AutomationLibrary, policy: PolicyValues, own: readonly Record<string, CapabilitySpec>[] = []): VocabularyView {
  return {
    capabilities: Object.fromEntries([...Object.entries(CAPABILITIES), ...own.flatMap((capabilities) => Object.entries(capabilities))].map(([id, spec]) => [id, capabilityWords(spec)])),
    meanings: Object.fromEntries(Object.entries(STANDARD_MEANINGS).map(([id, meaning]) => [id, { label: meaning.label, type: meaning.type, unit: 'unit' in meaning ? meaning.unit : null }])),
    links: Object.fromEntries(Object.entries(LINK_KINDS).map(([id, kind]) => [id, { verb: kind.verb, from: kind.from, to: kind.to, description: kind.description }])),
    recipes: library.recipes().map(({ recipe }) => ({
      id: recipe.id,
      label: recipe.label,
      description: recipe.description,
      roles: Object.fromEntries(
        Object.entries(recipe.roles).map(([role, spec]) => [role, isAutomationRole(spec) ? { label: spec.label, automation: true as const } : { label: spec.label, capabilities: spec.capabilities, ...(spec.oneOf ? { oneOf: spec.oneOf } : {}), ...(isGroupRole(spec) ? { group: true as const } : {}) }])
      ),
      params: recipe.params,
    })),
    policy: Object.fromEntries(Object.entries(POLICY_VALUES).map(([name, spec]) => [name, { label: spec.label, value: policy[name as keyof PolicyValues] ?? spec.default, unit: spec.unit }])),
  };
}
