import type { AutomationMode, PlaceKind, RoleBinding, RoleFills, Rule, WorldFill } from '@kraftverk/automation';
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

/** What the form edits, and what it does not: its mode, the home it is for, a clock of its own, how often it keeps things so. */
export type AutomationSettings = { mode: AutomationMode; homeId: string | null; timeZone: string | null; recheckMinutes: number | null };

/**
 * The family's people and places, as a file names them: each person by the
 * key the family's configuration gives them — their id, with none yet —
 * each home, zone and space by its own, a space with the home it is in.
 */
export type WorldKeys = { people: readonly { id: string; key: string }[]; places: readonly { id: string; key: string; kind: PlaceKind; homeId?: string }[] };

/** The family's people and places by their keys, as its configuration's vocabulary says them: what the app reads and writes a file's names by. */
export function worldKeysOf(vocabulary: Pick<Vocabulary, 'people' | 'homes' | 'zones' | 'spaces'>): WorldKeys {
  return {
    people: vocabulary.people.map(({ id, key }) => ({ id, key })),
    places: [
      ...vocabulary.homes.map(({ id, key }) => ({ id, key, kind: 'home' as const })),
      ...vocabulary.zones.map(({ id, key }) => ({ id, key, kind: 'zone' as const })),
      ...vocabulary.spaces.flatMap(({ id, key, home }) => {
        const homeId = vocabulary.homes.find((each) => each.key === home)?.id;
        return homeId ? [{ id, key, kind: 'space' as const, homeId }] : [];
      }),
    ],
  };
}

/** An automation as YAML text: its rule, what fills its roles, and its settings. */
export function automationYaml(
  automation: {
    name: string;
    rule: Rule;
    roles: Readonly<Record<string, RoleBinding>>;
    groups: Readonly<Record<string, readonly RoleBinding[]>>;
    starts: Readonly<Record<string, string>>;
    world?: Readonly<Record<string, WorldFill>>;
    madeFrom: string | null;
  } & AutomationSettings,
  devices: readonly DeviceView[],
  automations: readonly Pick<AutomationView, 'id' | 'key'>[],
  world: WorldKeys
): string {
  const { entry } = automationEntryFrom(
    { ...automation, ownTimeZone: automation.timeZone },
    {
      device: (id) => devices.find((device) => device.id === id)?.key ?? null,
      automation: (id) => automations.find((each) => each.id === id)?.key ?? null,
      home: (id) => world.places.find((place) => place.kind === 'home' && place.id === id)?.key ?? null,
      person: (id) => world.people.find((person) => person.id === id)?.key ?? null,
      place: (id, kind) => world.places.find((place) => place.kind === kind && place.id === id)?.key ?? null,
    }
  );
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
export function draftOfEntry(
  entry: AutomationEntry,
  devices: readonly DeviceView[],
  automations: readonly Pick<AutomationView, 'id' | 'key'>[],
  world: WorldKeys
): { draft: { name: string; rule: Rule } & RoleFills; settings: AutomationSettings } {
  const homes = world.places.filter((place) => place.kind === 'home');
  /** The home it says it is for, by id: none said, none — the family's. */
  const own = entry.home ? (homes.find((home) => home.key === entry.home)?.id ?? null) : null;
  // A space is of the automation's home: the one it says, or the family's first.
  const homeId = entry.home ? own : (homes[0]?.id ?? null);
  const fills = fillsFrom(entry.uses, {
    device: (key) => devices.find((device) => device.key === key && !device.removedAt)?.id ?? null,
    automation: (key) => automations.find((each) => each.key === key)?.id ?? null,
    person: (key) => world.people.find((person) => person.key === key)?.id ?? null,
    place: (kind, key) => world.places.find((place) => place.kind === kind && place.key === key && (kind !== 'space' || place.homeId === homeId))?.id ?? null,
  });
  return {
    draft: {
      name: entry.name,
      rule: entry.rule,
      roles: Object.fromEntries(Object.entries(fills.roles).map(([role, binding]) => [role, { device: savedDeviceId(binding.device), part: binding.part }])),
      groups: Object.fromEntries(Object.entries(fills.groups).map(([role, parts]) => [role, parts.map((binding) => ({ device: savedDeviceId(binding.device), part: binding.part }))])),
      starts: fills.starts as Record<string, AutomationId>,
      world: fills.world,
    },
    settings: { mode: entry.mode, homeId: own, timeZone: entry.clock, recheckMinutes: entry.recheckMinutes },
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
  // The master's, and those through a bridge: a configuration names those; another node's own it does not.
  const masters = ways.filter((way) => way.heldBy.kind === 'master' || way.through !== null);
  const entry = deviceEntryFrom(
    // The view says its type's first picture by name; a file leaves it out.
    { ...device, picture: device.picture === 'type:0' ? null : device.picture },
    masters.map((way) => ({
      method: way.method,
      through: way.through?.key ?? null,
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
  const nothing = !changes.devices.length && !changes.automations.length && !plan.links.some((link) => link.action !== 'same') && !plan.policy.length && !plan.family.length && !plan.homes.some((home) => home.action !== 'same') && !plan.scripts.some((script) => script.action !== 'same');
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
