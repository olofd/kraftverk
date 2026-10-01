import type { AutomationView, DeviceView, RoleBinding } from '@kraftverk/api-client';
import {
  automationEntryFrom,
  checkDocument,
  fillsFrom,
  MODE_OF_FILE,
  readAutomationYaml,
  unitsFrom,
  writeAutomationYaml,
  writeDeviceYaml,
  type AutomationEntry,
  type DeviceEntry,
  type EngineMode,
  type PrintContext,
  type Problem,
  type Scalar,
  type Vocabulary,
} from '@kraftverk/config';
import { savedDeviceId, type AutomationId, type Rule } from '@kraftverk/device-sdk';

/*
  An automation's and a device's own YAML, as their pages show it and the
  editor writes it (docs/CONFIG.md): made from what the app is shown, by the
  shared language — the same text the server's export writes — and read back
  into what the form edits, checked by the same code the server checks with.
*/

/** What the form edits, and what it does not: its mode, clock, how often it keeps things so, its place on the home page. */
export type AutomationSettings = { mode: EngineMode; timeZone: string; recheckMinutes: number | null; homePlace: number | null };

/** An automation as YAML text: its rule, what fills its roles, and its settings — and the context its numbers were written in. */
export function automationYaml(
  automation: { name: string; rule: Rule; roles: Readonly<Record<string, RoleBinding>>; starts: Readonly<Record<string, string>>; madeFrom: string | null } & AutomationSettings,
  devices: readonly DeviceView[],
  automations: readonly Pick<AutomationView, 'id' | 'key'>[]
): { text: string; context: PrintContext } {
  const context = unitsFrom(automation.roles, (id) => devices.find((device) => device.id === id)?.description ?? null);
  const { entry } = automationEntryFrom(automation, {
    device: (id) => devices.find((device) => device.id === id)?.key ?? null,
    automation: (id) => automations.find((each) => each.id === id)?.key ?? null,
  });
  return { text: writeAutomationYaml(entry, context), context };
}

/** An automation's YAML read: its entry — or null — and every problem, placed in its text, as the server would find them. */
export function readAutomationText(text: string, key: string, vocabulary: Vocabulary, context: PrintContext): { entry: AutomationEntry | null; problems: Problem[] } {
  return readAutomationYaml(text, key, context, (document) => checkDocument(document, vocabulary));
}

/**
 * What an entry read from YAML is, for the form and the server: its name, rule
 * and what fills each role by id, and its settings. A key naming nothing here
 * is a problem the meaning check has already said.
 */
export function draftOfEntry(entry: AutomationEntry, devices: readonly DeviceView[], automations: readonly Pick<AutomationView, 'id' | 'key'>[]): { draft: { name: string; rule: Rule; roles: Record<string, RoleBinding>; starts: Record<string, AutomationId> }; settings: AutomationSettings } {
  const fills = fillsFrom(entry.uses, {
    device: (key) => devices.find((device) => device.key === key && !device.removedAt)?.id ?? null,
    automation: (key) => automations.find((each) => each.key === key)?.id ?? null,
  });
  return {
    draft: {
      name: entry.name,
      rule: entry.rule,
      roles: Object.fromEntries(Object.entries(fills.roles).map(([role, binding]) => [role, { device: savedDeviceId(binding.device), part: binding.part }])),
      starts: fills.starts as Record<string, AutomationId>,
    },
    settings: { mode: MODE_OF_FILE[entry.mode], timeZone: entry.clock, recheckMinutes: entry.recheckMinutes, homePlace: entry.homePlace },
  };
}

const scalars = (values: Record<string, unknown>): Record<string, Scalar> =>
  Object.fromEntries(Object.entries(values).filter((entry): entry is [string, Scalar] => typeof entry[1] === 'string' || typeof entry[1] === 'number' || typeof entry[1] === 'boolean'));

/**
 * A device as YAML text, as an export writes it: what it is, its settings,
 * the ways the server reaches it — each secret by name, never its value. A
 * way an app holds is not in a configuration: its keys live on the phone.
 */
export function deviceYaml(device: DeviceView, vocabulary: Vocabulary | null): { text: string; secrets: number; heldByApps: number } {
  const type = vocabulary?.types.find((each) => each.id === device.typeId);
  const ways = [...device.connections].sort((a, b) => a.priority - b.priority);
  const entry: DeviceEntry = {
    type: device.typeId,
    name: device.name,
    identity: device.identity,
    picture: device.picture === 'type:0' ? null : device.picture,
    settings: scalars(device.config),
    connect: ways
      .filter((way) => way.heldBy.kind === 'server')
      .map((way) => ({
        via: way.method,
        address: type?.methods.find((method) => method.id === way.method)?.fixedAddress ? null : way.address,
        settings: scalars(way.config),
        secrets: Object.fromEntries(way.secrets.map((field) => [field, { secret: `${device.key}.${field}` }])),
        exportable: way.secretsExportable,
      })),
  };
  return { text: writeDeviceYaml(entry), secrets: entry.connect.reduce((count, way) => count + Object.keys(way.secrets).length, 0), heldByApps: ways.length - entry.connect.length };
}
