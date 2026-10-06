import type { AutomationMode, RoleBinding, RoleFills, Rule } from '@kraftverk/automation';
import { savedDeviceId, type AutomationId } from '@kraftverk/device-sdk';
import {
  automationEntryFrom,
  checkDocument,
  deviceEntryFrom,
  fillsFrom,
  readAutomationYaml,
  writeAutomationYaml,
  writeDeviceYaml,
  type AutomationEntry,
  type Problem,
  type Vocabulary,
} from '@kraftverk/home-file';

import type { AutomationView, DeviceView, ImportItem, ImportPlan } from '@kraftverk/api-contract';

/*
  An automation's and a device's own YAML, as their pages show it and the
  editor writes it (docs/CONFIG.md): made from what a home shows — its views —
  by the configuration's own functions, the same the master's export writes
  with, and read back into what the form edits, checked by the same code the
  master checks with.
*/

/** What the form edits, and what it does not: its mode, clock, how often it keeps things so, its place on the home page. */
export type AutomationSettings = { mode: AutomationMode; timeZone: string; recheckMinutes: number | null; homePlace: number | null };

/** An automation as YAML text: its rule, what fills its roles, and its settings. */
export function automationYaml(
  automation: { name: string; rule: Rule; roles: Readonly<Record<string, RoleBinding>>; groups: Readonly<Record<string, readonly RoleBinding[]>>; starts: Readonly<Record<string, string>>; madeFrom: string | null } & AutomationSettings,
  devices: readonly DeviceView[],
  automations: readonly Pick<AutomationView, 'id' | 'key'>[]
): string {
  const { entry } = automationEntryFrom(automation, {
    device: (id) => devices.find((device) => device.id === id)?.key ?? null,
    automation: (id) => automations.find((each) => each.id === id)?.key ?? null,
  });
  return writeAutomationYaml(entry);
}

/**
 * An automation's YAML read: its entry — or null — every problem, placed in
 * its text, as the server would find them; and its key: a whole file of just
 * it, pasted in, says its own.
 */
export function readAutomationText(text: string, key: string, vocabulary: Vocabulary): { entry: AutomationEntry | null; problems: Problem[]; key: string } {
  return readAutomationYaml(text, key, (document) => checkDocument(document, vocabulary));
}

/**
 * What an entry read from YAML is, for the form and the server: its name, rule
 * and what fills each role by id, and its settings. A key naming nothing here
 * is a problem the meaning check has already said.
 */
export function draftOfEntry(entry: AutomationEntry, devices: readonly DeviceView[], automations: readonly Pick<AutomationView, 'id' | 'key'>[]): { draft: { name: string; rule: Rule } & RoleFills; settings: AutomationSettings } {
  const fills = fillsFrom(entry.uses, {
    device: (key) => devices.find((device) => device.key === key && !device.removedAt)?.id ?? null,
    automation: (key) => automations.find((each) => each.key === key)?.id ?? null,
  });
  return {
    draft: {
      name: entry.name,
      rule: entry.rule,
      roles: Object.fromEntries(Object.entries(fills.roles).map(([role, binding]) => [role, { device: savedDeviceId(binding.device), part: binding.part }])),
      groups: Object.fromEntries(Object.entries(fills.groups).map(([role, parts]) => [role, parts.map((binding) => ({ device: savedDeviceId(binding.device), part: binding.part }))])),
      starts: fills.starts as Record<string, AutomationId>,
    },
    settings: { mode: entry.mode, timeZone: entry.clock, recheckMinutes: entry.recheckMinutes, homePlace: entry.homePlace },
  };
}

/**
 * A device as YAML text, as an export writes it: what it is, its settings,
 * the ways its master reaches it — each secret by name, never its value. A
 * way another node holds is not in a configuration: its keys live there.
 */
export function deviceYaml(device: DeviceView, vocabulary: Vocabulary | null): { text: string; secrets: number; heldElsewhere: number } {
  const type = vocabulary?.types.find((each) => each.id === device.typeId);
  const ways = [...device.connections].sort((a, b) => a.priority - b.priority);
  const masters = ways.filter((way) => way.heldBy.kind === 'master');
  const entry = deviceEntryFrom(
    // The view says its type's first picture by name; a file leaves it out.
    { ...device, picture: device.picture === 'type:0' ? null : device.picture },
    masters.map((way) => ({
      method: way.method,
      address: way.address,
      config: way.config,
      secrets: Object.fromEntries(way.secrets.map((field) => [field, { secret: `${device.key}.${field}` }])),
      exportable: way.secretsExportable,
      fixedAddress: Boolean(type?.methods.find((method) => method.id === way.method)?.fixedAddress),
    }))
  );
  return { text: writeDeviceYaml(entry), secrets: entry.connect.reduce((count, way) => count + Object.keys(way.secrets).length, 0), heldElsewhere: ways.length - masters.length };
}

// --- an import's plan, as it is answered ---------------------------------------------------------

/** What an import will do to one thing, or nothing when it is the same already. */
const doing = (items: readonly ImportItem[]) => items.filter((item) => item.action !== 'same');

/** The key an answer for one secret is given under: the device's key, and the field. */
export const secretAnswerKey = (need: { device: string; field: string }): string => `${need.device}.${need.field}`;

/** The key an answer for one role is given under: the automation's key, and the role. */
export const rebindAnswerKey = (need: { automation: string; role: string }): string => `${need.automation}.${need.role}`;

/** What an import would change: the devices and automations it would add or change, each chosen until a person leaves it out. */
export const changesOf = (plan: ImportPlan): { devices: string[]; automations: string[] } => ({
  devices: doing(plan.devices).map((item) => item.key),
  automations: doing(plan.automations).map((item) => item.key),
});

/**
 * What an import's plan still needs before it can be applied, given what is
 * chosen and what is answered: nothing to do at all; the passphrase; each
 * secret of a chosen device, and each role of a chosen automation, not yet
 * given — and whether it is ready. Whether everything is chosen, too: then
 * the plan is applied as it is.
 */
export function planReadiness(
  plan: ImportPlan,
  chosen: { devices: ReadonlySet<string>; automations: ReadonlySet<string> },
  answers: { secrets: Readonly<Record<string, string>>; rebind: Readonly<Record<string, string>> }
): { nothing: boolean; secretsMissing: ImportPlan['needs']['secrets']; rebindMissing: ImportPlan['needs']['rebind']; ready: boolean; everything: boolean } {
  const changes = changesOf(plan);
  const nothing = !changes.devices.length && !changes.automations.length && !plan.links.some((link) => link.action !== 'same') && !plan.policy.length && !plan.location;
  const secretsMissing = plan.needs.secrets.filter((need) => chosen.devices.has(need.device) && !answers.secrets[secretAnswerKey(need)]);
  const rebindMissing = plan.needs.rebind.filter((need) => chosen.automations.has(need.automation) && !answers.rebind[rebindAnswerKey(need)]);
  return {
    nothing,
    secretsMissing,
    rebindMissing,
    ready: plan.id !== null && !plan.needs.passphrase && !secretsMissing.length && !rebindMissing.length && !nothing,
    everything: chosen.devices.size === changes.devices.length && chosen.automations.size === changes.automations.length,
  };
}
