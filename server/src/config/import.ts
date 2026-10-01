import { randomBytes } from 'node:crypto';

import type { ImportApplied, ImportItem, ImportPlan } from '@kraftverk/api-contract';
import { checkDocument, MAIN, MODE_IN_FILE, MODE_OF_FILE, readConfig, useOf, useText, type AutomationEntry, type ConfigDocument, type DeviceEntry, type SecretValue } from '@kraftverk/config';
import {
  capabilitiesOf,
  isSecretField,
  checkBinding,
  checkRule,
  isAutomationRole,
  isSimulated,
  meetsNeed,
  methodsOf,
  partsOf,
  POLICY_VALUES,
  takesSteps,
  validateConfig,
  type AutomationId,
  type BoundPart,
  type ConfigValues,
  type PartRole,
  type PolicyValueName,
  type SavedDeviceId,
} from '@kraftverk/device-sdk';

import type { AutomationEngine, AutomationRecord } from '../automations/engine.ts';
import { hasConditions, type Checked } from '../automations/plans.ts';
import type { AutomationLibrary } from '../automations/library.ts';
import type { DeviceRecord } from '../devices/catalog.ts';
import type { DeviceSessionManager } from '../devices/sessions.ts';
import { db } from '../history/db.ts';
import type { TransportHost } from '../runtime/transports.ts';
import { policyValues, setPolicyValue } from '../history/policy.ts';
import { serverVocabulary, type ConfigDeps } from './export.ts';
import { isSealed, openKept, openWith } from './seal.ts';

/*
  Importing a configuration (docs/CONFIG.md), in two steps. The plan reads a
  file and says what it would do — each device, link, automation and home
  value added, changed (and how), left, or removed — with every problem at
  its line, and what it still needs: a passphrase, a secret it does not
  carry, a device of yours for a role naming one you do not have, a yes to
  what it would set acting on its own or take away. Nothing is written. The
  apply writes a plan, with those answers, in one transaction: an automation
  that fails its check undoes the devices added for it too.

  Things are matched by key. A device's type is what it is: a key naming a
  device of another type is a problem, not a change. Restoring the snapshot
  kept beside the database is an import that asks nothing: its secrets are
  the server's own, and what acted acts again.
*/

export type ImportDeps = ConfigDeps & {
  sessions: Pick<DeviceSessionManager, 'sync'>;
  /** Whether a transport's addresses belong to one device each. */
  transports: Pick<TransportHost, 'definition'>;
  library: AutomationLibrary;
  engine: Pick<AutomationEngine, 'reset' | 'poke' | 'forget'>;
  /** The automation checks the API applies to an automation made or changed (`automations/plans.ts`). */
  checked: (draft: { rule: AutomationRecord['rule']; roles: Record<string, { device: SavedDeviceId; part: string }>; starts: Record<string, AutomationId> }, self: AutomationId | null) => Checked;
};

export type ImportMode = 'merge' | 'replace';

/** A plan, kept for its apply: the document, the secrets it opened, and what it found. */
type Kept = {
  view: ImportPlan;
  document: ConfigDocument;
  mode: ImportMode;
  /** Each secret by "device.connectIndex.field": opened, or still needed. */
  secrets: Map<string, string>;
  by: string;
  expiresAt: number;
  /** Restoring: automations restored turned off, and why. */
  turnedOff: Map<string, string[]>;
};

const PLAN_TTL_MS = 15 * 60_000;
const plans = new Map<string, Kept>();


export class ImportError extends Error {
  constructor(
    message: string,
    readonly problems: string[] = [],
    readonly status: 400 | 404 | 409 = 400
  ) {
    super(message);
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const secretKey = (device: string, index: number, field: string) => `${device}.${index}.${field}`;

/**
 * What importing a file would do. `kept`: the snapshot's own secrets, sealed
 * with this server's key, are opened as the server opens them.
 */
export function planImport(deps: ImportDeps, text: string, options: { mode: ImportMode; passphrase?: string; by: string; kept?: boolean; lenient?: boolean }): ImportPlan {
  const vocabulary = serverVocabulary(deps);
  // A restore reads what it can: an entry it cannot read is left out and said, never the whole home lost for it.
  const read = readConfig(text, {}, (document) => checkDocument(document, vocabulary, { hasSecret: () => true, uses: 'leave' }), { partial: options.lenient });
  const empty: ImportPlan = { id: null, from: read.from, problems: read.problems.map((each) => ({ ...each, path: [...each.path] })), devices: [], links: [], automations: [], policy: [], needs: { passphrase: null, secrets: [], rebind: [], confirm: [] }, notes: [] };
  if (!read.document) return empty;
  const document = read.document;
  const problems: ImportPlan['problems'] = [];
  const needs: ImportPlan['needs'] = { passphrase: null, secrets: [], rebind: [], confirm: [] };
  const notes: string[] = [];
  /*
    Restoring, item by item: a device it cannot keep is left out, an
    automation it cannot keep as it was is restored turned off — each said —
    and everything else is restored. An import a person reads stops at its
    first problem instead, for them to fix.
  */
  const leftOut = new Set<string>();
  const turnedOff = new Map<string, string[]>();
  const problem = (message: string, path: (string | number)[]) => {
    if (options.lenient && path[0] === 'devices' && typeof path[1] === 'string') {
      leftOut.add(path[1]);
      notes.push(`${path[1]} is left out: ${message}`);
      return;
    }
    if (options.lenient && path[0] === 'automations' && typeof path[1] === 'string') {
      turnedOff.set(path[1], [...(turnedOff.get(path[1]) ?? []), message]);
      return;
    }
    problems.push({ message, path, line: null, column: null });
  };
  if (options.lenient) for (const each of read.problems) notes.push(`${each.line ? `line ${each.line}: ` : ''}${each.message} — left out`);
  // One device's or automation's own YAML, as its page shows it: read under a key made from its name, which an import matches by.
  if (read.holds) notes.push(`Read as one ${read.holds.kind === 'devices' ? 'device' : 'automation'}, known by "${read.holds.key}"${(read.holds.kind === 'devices' ? deps.catalog.byKey(read.holds.key) : deps.automations.byKey(read.holds.key)) ? ': the one you have by that key is changed to it' : ''}`);
  const secrets = new Map<string, string>();

  // Secrets: opened now, or said to be needed.
  const open = (value: string): string | null => {
    if (value.startsWith('sealed:server:')) return options.kept ? openKept(value) : null;
    if (!isSealed(value)) return value;
    if (!options.passphrase) {
      needs.passphrase = 'missing';
      return null;
    }
    try {
      return openWith(options.passphrase, value);
    } catch {
      needs.passphrase = 'wrong';
      return null;
    }
  };
  const valueOf = (secret: SecretValue): string | null =>
    'plain' in secret ? secret.plain : 'sealed' in secret ? open(secret.sealed) : document.secrets[secret.secret] !== undefined ? open(document.secrets[secret.secret]!) : null;

  // Devices.
  const devices: ImportItem[] = [];
  for (const [key, entry] of Object.entries(document.devices)) {
    const type = deps.types.get(entry.type)!;
    const existing = deps.catalog.byKey(key);
    if (existing && existing.typeId !== entry.type) {
      problem(`"${key}" is ${existing.name}, a ${existing.typeId}, here: a device does not change its type. Give it another key`, ['devices', key, 'type']);
      continue;
    }
    if (entry.identity) {
      const owner = deps.catalog.byIdentity(entry.identity).active;
      if (owner && owner.key !== key) problem(`That device is already yours, as "${owner.name}" (${owner.key})`, ['devices', key, 'identity']);
    }
    entry.connect.forEach((way, index) => {
      const method = methodsOf(type).find((each) => each.id === way.via)!;
      const address = way.address ?? method.address ?? '';
      // An address belongs to one device where its transport says so — never a simulator's, which every simulated device shares — as setup decides it.
      const exclusive = !isSimulated(method) && deps.transports.definition(method.transport)?.exclusive !== false;
      const claim = exclusive ? deps.connections.claimant(method.transport, address) : null;
      if (claim && claim.deviceId !== existing?.id) problem(`Another device you have is already reached at ${address}`, ['devices', key, 'connect', index, 'address']);
      const credentials = deps.protocols.get(method.protocol)?.credentials?.schema.fields ?? {};
      const had = existing ? deps.connections.forDevice(existing.id).find((connection) => connection.heldBy === null && connection.method === way.via) : undefined;
      for (const [field, spec] of Object.entries(credentials)) {
        if (!isSecretField(spec)) continue;
        const given = way.secrets[field];
        const value = given ? valueOf(given) : null;
        if (value !== null) secrets.set(secretKey(key, index, field), value);
        else if (had && deps.connections.secret(had.id, field) !== null) continue;
        else if (given || spec.required) needs.secrets.push({ device: key, deviceName: entry.name, field, title: spec.title });
      }
    });
    if (leftOut.has(key)) continue;
    const back = existing ? null : removedMatch(deps, key, entry);
    devices.push(existing ? { key, name: entry.name, ...deviceChanges(deps, existing, entry, secrets, key) } : { key, name: entry.name, action: back ? 'restore' : 'add', changes: back ? [`brought back, with its history (removed ${back.removedAt!.slice(0, 10)})`] : [] });
  }
  if (needs.passphrase) notes.push(needs.passphrase === 'missing' ? 'It carries secrets sealed with a passphrase: give it to open them' : 'The passphrase given does not open its secrets');

  // Links.
  const idOf = (key: string): SavedDeviceId | null => deps.catalog.byKey(key)?.id ?? null;
  const links: ImportPlan['links'] = document.links.filter((link) => !leftOut.has(link.from.device) && !leftOut.has(link.to.device)).map((link) => {
    const [from, to] = [idOf(link.from.device), idOf(link.to.device)];
    const there = from && to && deps.links.all().some((each) => each.kind === link.kind && each.source.device === from && each.source.part === link.from.part && each.target.device === to && each.target.part === link.to.part);
    return { kind: link.kind, from: useText(link.from), to: useText(link.to), action: there ? 'same' : 'add' };
  });

  // Automations.
  const automations: ImportItem[] = [];
  for (const [key, entry] of Object.entries(document.automations)) {
    const path = ['automations', key];
    for (const said of checkRule(entry.rule, deps.library)) problem(said, path);
    if (entry.recheckMinutes !== null && !(hasConditions(entry.rule) && !takesSteps(entry.rule))) problem('Only an automation that waits for a condition, and does what it does at once, can keep things so ("recheck")', [...path, 'recheck']);
    // A role nothing fills — a rule written while it was being built — cannot run: said where it is.
    for (const [role, spec] of Object.entries(entry.rule.roles)) if (!entry.uses[role]) problem(`${spec.label}: nothing fills it — name ${isAutomationRole(spec) ? 'an automation' : 'a device'} for it`, [...path, 'uses', role]);
    for (const [role, use] of Object.entries(entry.uses)) {
      const spec = entry.rule.roles[role];
      if ('automation' in use) {
        if (!document.automations[use.automation] && !deps.automations.byKey(use.automation)) problem(`There is no automation "${use.automation}", in the file or here`, [...path, 'uses', role]);
        continue;
      }
      if ((document.devices[use.device] && !leftOut.has(use.device)) || deps.catalog.byKey(use.device)) continue;
      // A device you do not have: one of yours that can do what the role needs — or, restoring, nothing yet.
      const need = spec && !isAutomationRole(spec) ? spec : null;
      if (options.lenient) problem(`${spec?.label ?? role}: "${useText(use)}" is not here`, [...path, 'uses', role]);
      else needs.rebind.push({ automation: key, role, label: spec?.label ?? role, wanted: useText(use), candidates: candidatesFor(deps, need, document) });
    }
    // What fills each part, checked as the apply will: a part that cannot do what its role needs is said now, not after a yes.
    for (const said of bindingProblems(deps, entry, document, leftOut)) problem(said.message, [...path, ...said.path]);
    const existing = deps.automations.byKey(key);
    const acts = entry.mode === 'act' && (!existing || existing.mode !== 'armed' || !same(existing.rule, entry.rule) || existing.recheckMinutes !== entry.recheckMinutes);
    if (acts) needs.confirm.push(`"${entry.name}" will act on its own${existing?.mode === 'armed' ? ', doing what the file says' : ''}`);
    automations.push(existing ? { key, name: entry.name, ...automationChanges(deps, existing, entry) } : { key, name: entry.name, action: 'add', changes: [] });
  }

  // The home's values.
  const now = policyValues();
  const policy = Object.entries(document.home.policy)
    .filter(([name, value]) => now[name as PolicyValueName] !== value)
    .map(([name, value]) => ({ name, label: POLICY_VALUES[name as PolicyValueName].label, before: now[name as PolicyValueName] ?? null, after: value }));

  // Replacing: what the file does not have goes.
  if (options.mode === 'replace') {
    const gone = deps.catalog.list().filter((device) => !document.devices[device.key]);
    for (const device of gone) devices.push({ key: device.key, name: device.name, action: 'remove', changes: [] });
    const goneAutomations = deps.automations.list().filter((automation) => !document.automations[automation.key]);
    for (const automation of goneAutomations) automations.push({ key: automation.key, name: automation.name, action: 'remove', changes: [] });
    const keyOf = new Map(deps.catalog.list().map((device) => [device.id as string, device.key]));
    for (const link of deps.links.all()) {
      const from = useText({ device: keyOf.get(link.source.device) ?? '', part: link.source.part });
      const to = useText({ device: keyOf.get(link.target.device) ?? '', part: link.target.part });
      if (!links.some((each) => each.kind === link.kind && each.from === from && each.to === to)) links.push({ kind: link.kind, from, to, action: 'remove' });
    }
    if (gone.length) needs.confirm.push(`${gone.length === 1 ? `"${gone[0]!.name}" is` : `${gone.length} devices are`} removed: ${gone.map((device) => device.name).join(', ')} — their history is kept`);
    if (goneAutomations.length) needs.confirm.push(`${goneAutomations.length === 1 ? `"${goneAutomations[0]!.name}" is` : `${goneAutomations.length} automations are`} deleted`);
  }

  // Placed in the text: what the plan found, at its line where it has one.
  const placed = problems.map((each) => {
    const at = read.problems.length ? null : locate(text, each.path);
    return { ...each, line: at?.line ?? null, column: at?.column ?? null };
  });
  const id = placed.length ? null : `p-${randomBytes(9).toString('base64url')}`;
  const view: ImportPlan = { id, from: read.from, problems: placed, devices, links, automations, policy, needs, notes };
  if (id) {
    for (const [planId, kept] of plans) if (kept.expiresAt < Date.now()) plans.delete(planId);
    plans.set(id, { view, document, mode: options.mode, secrets, by: options.by, expiresAt: Date.now() + PLAN_TTL_MS, turnedOff });
  }
  return view;
}

/** Where a path is in the text: the reader's own placing, for problems the plan finds after reading. */
function locate(text: string, path: (string | number)[]): { line: number | null; column: number | null } {
  const placed = readConfig(text, {}, () => [{ message: '', path }]).problems[0];
  return { line: placed?.line ?? null, column: placed?.column ?? null };
}

/**
 * What fills each part role — a device here, or one the file brings —
 * checked as an automation's own checks do: the part is there, it can do what
 * the role needs, and it reports, raises and lets be written what the rule
 * asks of it. A role filled by neither is said elsewhere (rebind, or not here).
 */
function bindingProblems(deps: ImportDeps, entry: AutomationEntry, document: ConfigDocument, leftOut: ReadonlySet<string>): { message: string; path: (string | number)[] }[] {
  const found: { message: string; path: (string | number)[] }[] = [];
  const bound = new Map<string, BoundPart>();
  for (const [role, spec] of Object.entries(entry.rule.roles)) {
    const use = entry.uses[role];
    if (isAutomationRole(spec) || !use || 'automation' in use) continue;
    const brought = leftOut.has(use.device) ? undefined : document.devices[use.device];
    const here = deps.catalog.byKey(use.device);
    // The file's own word on it first: what it will be once imported.
    const description = brought ? deps.types.get(brought.type)?.describe(brought.settings as never) : here?.description;
    const name = brought?.name ?? here?.name;
    if (!description || !name) continue;
    if (!partsOf(description).some((part) => part.id === use.part)) {
      found.push({ message: `${spec.label}: ${name} has no part "${use.part}"`, path: ['uses', role] });
      continue;
    }
    const capabilities = capabilitiesOf(description, use.part);
    if (!meetsNeed(spec, capabilities)) {
      found.push({ message: `${spec.label}: that part of ${name} cannot do what it needs (${spec.capabilities.join(', ')})`, path: ['uses', role] });
      continue;
    }
    bound.set(role, { name: use.part === MAIN ? name : `${name} — ${use.part}`, description, part: use.part, capabilities });
  }
  // What the filled parts must report and let be written: once the rule itself holds.
  if (checkRule(entry.rule, deps.library).length) return found;
  const filled = Object.fromEntries(Object.entries(entry.rule.roles).filter(([role, spec]) => !isAutomationRole(spec) && bound.has(role)));
  for (const said of checkBinding({ ...entry.rule, roles: filled }, (role) => bound.get(role) ?? null)) found.push({ message: said, path: [] });
  return found;
}

/** A device you removed that this entry is: the same type, by its identity — or by its key, when the entry says none. Brought back, its history is its own again. */
function removedMatch(deps: ImportDeps, key: string, entry: DeviceEntry): DeviceRecord | null {
  const removed = deps.catalog.removed().filter((device) => device.typeId === entry.type);
  return (entry.identity ? removed.find((device) => device.identity === entry.identity) : removed.find((device) => device.key === key)) ?? null;
}

/**
 * The parts that can do what a role needs: what a role naming a device you do
 * not have can be given instead — your devices', and those the file adds.
 */
function candidatesFor(deps: ImportDeps, need: PartRole | null, document: ConfigDocument): { use: string; name: string }[] {
  const yours = deps.catalog.list().map((device) => ({ key: device.key, name: device.name, description: device.description }));
  const added = Object.entries(document.devices)
    .filter(([key]) => !deps.catalog.byKey(key))
    .flatMap(([key, entry]) => {
      const type = deps.types.get(entry.type);
      return type ? [{ key, name: entry.name, description: type.describe(entry.settings as never) }] : [];
    });
  return [...yours, ...added].flatMap((device) =>
    partsOf(device.description)
      .filter((part) => !need || meetsNeed(need, capabilitiesOf(device.description, part.id)))
      .map((part) => ({ use: useText({ device: device.key, part: part.id }), name: part.id === MAIN ? device.name : `${device.name} — ${part.label}` }))
  );
}

/** How a device would change: each difference in words, or "same". */
function deviceChanges(deps: ImportDeps, existing: DeviceRecord, entry: DeviceEntry, secrets: Map<string, string>, key: string): Pick<ImportItem, 'action' | 'changes'> {
  const changes: string[] = [];
  if (existing.name !== entry.name) changes.push(`name: ${existing.name} → ${entry.name}`);
  if (entry.identity !== null && existing.identity !== entry.identity) changes.push('who it is: its identity');
  if (entry.picture !== existing.picture && entry.picture !== null) changes.push('its picture');
  const settings = [...new Set([...Object.keys(existing.config), ...Object.keys(entry.settings)])].filter((name) => existing.config[name] !== entry.settings[name] && entry.settings[name] !== undefined);
  if (settings.length) changes.push(`settings: ${settings.join(', ')}`);
  const ways = deps.connections.forDevice(existing.id).filter((connection) => connection.heldBy === null);
  entry.connect.forEach((way, index) => {
    const had = ways.find((connection) => connection.method === way.via);
    if (!had) changes.push(`reached ${way.via} as well`);
    else {
      if (way.address !== null && had.address !== way.address) changes.push(`${way.via}: at ${way.address}, not ${had.address}`);
      if (!same(had.config, { ...had.config, ...way.settings })) changes.push(`${way.via}: its settings`);
      if (had.secretsExportable !== way.exportable) changes.push(`${way.via}: its secrets ${way.exportable ? 'may' : 'may no longer'} leave in plain text`);
      for (const field of deps.connections.secretFields(had.id)) {
        const given = secrets.get(secretKey(key, index, field));
        if (given !== undefined && given !== deps.connections.secret(had.id, field)) changes.push(`${way.via}: a new ${field}`);
      }
    }
  });
  for (const had of ways) if (!entry.connect.some((way) => way.via === had.method)) changes.push(`no longer reached ${had.method}`);
  return changes.length ? { action: 'change', changes } : { action: 'same', changes };
}

/** How an automation would change: each difference in words, or "same". */
function automationChanges(deps: ImportDeps, existing: AutomationRecord, entry: AutomationEntry): Pick<ImportItem, 'action' | 'changes'> {
  const changes: string[] = [];
  if (existing.name !== entry.name) changes.push(`name: ${existing.name} → ${entry.name}`);
  if (existing.mode !== MODE_OF_FILE[entry.mode]) changes.push(`${MODE_IN_FILE[existing.mode]} → ${entry.mode}`);
  if (!same(existing.rule, entry.rule)) changes.push('what it does');
  const keyOf = (id: SavedDeviceId) => deps.catalog.get(id)?.key ?? '?';
  for (const [role, use] of Object.entries(entry.uses)) {
    const had = existing.roles[role];
    const hadAutomation = existing.starts[role];
    if ('device' in use && (!had || keyOf(had.device) !== use.device || had.part !== use.part)) changes.push(`${role}: ${had ? useText({ device: keyOf(had.device), part: had.part }) : 'nothing'} → ${useText(use)}`);
    if ('automation' in use && (!hadAutomation || deps.automations.get(hadAutomation)?.key !== use.automation)) changes.push(`${role}: starts ${use.automation}`);
  }
  if (existing.timeZone !== entry.clock) changes.push(`clock: ${existing.timeZone} → ${entry.clock}`);
  if (existing.recheckMinutes !== entry.recheckMinutes) changes.push('how often it keeps things so');
  if (existing.homePlace !== entry.homePlace) changes.push(entry.homePlace === null ? 'off the home page' : 'its place on the home page');
  return changes.length ? { action: 'change', changes } : { action: 'same', changes };
}

/** The answers a plan asked for. */
export type ImportChoices = {
  /** Only these, by key; everything the plan has when not given. */
  include?: { devices?: string[]; automations?: string[] };
  /** A secret the file did not carry: "device.field" → its value. */
  secrets?: Record<string, string>;
  /** A role naming a device you do not have: "automation.role" → "device-key.part". */
  rebind?: Record<string, string>;
};

/** A kept plan, if it is this person's and still current. */
export function keptPlan(id: string, by: string): ImportPlan | null {
  const kept = plans.get(id);
  return kept && kept.by === by && kept.expiresAt > Date.now() ? kept.view : null;
}

/**
 * Writes a plan, with its answers, in one transaction — or nothing, and why.
 * The plan is used up. Confirmation is the caller's: what it asks a yes to is
 * in the plan's `needs.confirm`.
 */
export async function applyImport(deps: ImportDeps, id: string, by: string, choices: ImportChoices, options: { lenient?: boolean } = {}): Promise<ImportApplied> {
  const kept = plans.get(id);
  if (!kept || kept.by !== by || kept.expiresAt < Date.now()) throw new ImportError('That plan has gone: read the file again', [], 404);
  const { document, view } = kept;
  if (view.needs.passphrase) throw new ImportError(view.needs.passphrase === 'missing' ? 'Give the passphrase its secrets are sealed with' : 'The passphrase does not open its secrets');
  const devicesIn = (key: string) => !choices.include?.devices || choices.include.devices.includes(key);
  const automationsIn = (key: string) => !choices.include?.automations || choices.include.automations.includes(key);

  // Every answer it asked for.
  const missing: string[] = [];
  // A restore asks nothing: a device whose secret is gone is restored without it.
  if (!options.lenient) for (const need of view.needs.secrets) if (devicesIn(need.device) && !choices.secrets?.[`${need.device}.${need.field}`]) missing.push(`${need.deviceName}: its ${need.title}`);
  if (!options.lenient) for (const need of view.needs.rebind) if (automationsIn(need.automation) && !choices.rebind?.[`${need.automation}.${need.role}`]) missing.push(`"${document.automations[need.automation]?.name}": a device for ${need.label}`);
  if (missing.length) throw new ImportError(`It still needs ${missing.join('; ')}`, missing);

  const applied: ImportApplied = { devices: { added: [], restored: [], changed: [], removed: [] }, automations: { added: [], changed: [], removed: [] }, links: { added: 0, removed: 0 }, policy: [], notes: [] };
  const touched: AutomationId[] = [];
  /** Restoring, each in a savepoint of its own: what fails is undone alone, said, and the rest goes on. */
  const each = (what: string, work: () => void) => {
    if (!options.lenient) return work();
    try {
      db().transaction(work)();
    } catch (error) {
      applied.notes.push(`${what} could not be restored: ${error instanceof ImportError && error.problems.length ? error.problems.join('; ') : (error as Error).message}`);
    }
  };
  const forgotten: AutomationId[] = [];

  db().transaction(() => {
    // Devices: added, changed, removed.
    for (const item of view.devices) {
      if (!devicesIn(item.key)) continue;
      if (item.action === 'remove') {
        const device = deps.catalog.byKey(item.key);
        if (device && deps.catalog.remove(device.id)) applied.devices.removed.push(item.key);
        continue;
      }
      if (item.action === 'same') continue;
      const entry = document.devices[item.key]!;
      each(entry.name, () => {
        writeDevice(deps, item.key, entry, kept.secrets, choices.secrets ?? {});
        (item.action === 'add' ? applied.devices.added : item.action === 'restore' ? applied.devices.restored : applied.devices.changed).push(item.key);
      });
    }

    // Links: the file's between the devices there are now; those it does not have, when replacing.
    for (const link of view.links) {
      const from = useOf(link.from)!;
      const to = useOf(link.to)!;
      const [source, target] = [deps.catalog.byKey(from.device), deps.catalog.byKey(to.device)];
      if (!source || !target) continue;
      if (link.action === 'add') {
        deps.links.add({ kind: link.kind as never, source: { device: source.id, part: from.part }, target: { device: target.id, part: to.part } });
        applied.links.added += 1;
      } else if (link.action === 'remove') {
        const found = deps.links.all().find((each) => each.kind === link.kind && each.source.device === source.id && each.source.part === from.part && each.target.device === target.id && each.target.part === to.part);
        if (found) (deps.links.remove(found.id), (applied.links.removed += 1));
      }
    }

    // Automations: made first without what they start, so one may start another made with it; then whole.
    const written: { key: string; entry: AutomationEntry; id: AutomationId; existing: AutomationRecord | null }[] = [];
    for (const item of view.automations) {
      if (!automationsIn(item.key)) continue;
      if (item.action === 'remove') {
        const automation = deps.automations.byKey(item.key);
        if (automation && deps.automations.delete(automation.id)) (applied.automations.removed.push(item.key), forgotten.push(automation.id));
        continue;
      }
      if (item.action === 'same') continue;
      const entry = document.automations[item.key]!;
      const existing = deps.automations.byKey(item.key);
      const id = existing?.id ?? deps.automations.create({ key: item.key, name: entry.name, rule: entry.rule, madeFrom: entry.madeFrom, roles: {}, starts: {}, timeZone: entry.clock, recheckMinutes: entry.recheckMinutes }).id;
      written.push({ key: item.key, entry, id, existing });
    }
    for (const { key, entry, id, existing } of written) {
      const roles: Record<string, { device: SavedDeviceId; part: string }> = {};
      const starts: Record<string, AutomationId> = {};
      for (const [role, use] of Object.entries(entry.uses)) {
        if ('automation' in use) {
          const other = deps.automations.byKey(use.automation);
          if (other) starts[role] = other.id;
          continue;
        }
        const named = deps.catalog.byKey(use.device) ? use : useOf(choices.rebind?.[`${key}.${role}`] ?? '');
        const device = named ? deps.catalog.byKey(named.device) : null;
        if (device && named) roles[role] = { device: device.id, part: named.part };
      }
      const result = deps.checked({ rule: entry.rule, roles, starts }, id);
      // Restoring, one that cannot be kept as it was is kept turned off — its rule, what still fills it — and said: its owner's work is not lost.
      const why = [...new Set([...(kept.turnedOff.get(key) ?? []), ...result.problems])];
      if (why.length && !options.lenient) throw new ImportError(`"${entry.name}" cannot be kept as it is`, why.map((said) => `"${entry.name}": ${said}`));
      each(`"${entry.name}"`, () => {
        deps.automations.update(id, { name: entry.name, rule: entry.rule, roles: result.roles, starts: result.starts, timeZone: entry.clock, mode: why.length ? 'off' : MODE_OF_FILE[entry.mode], recheckMinutes: entry.recheckMinutes });
        if (entry.homePlace !== (existing?.homePlace ?? null)) deps.automations.placeOnHome(id, entry.homePlace);
        (existing ? applied.automations.changed : applied.automations.added).push(key);
        if (why.length) applied.notes.push(`"${entry.name}" is restored turned off: ${why.join('; ')}`);
        touched.push(id);
      });
    }

    // The home's values.
    for (const change of view.policy) {
      setPolicyValue(change.name as PolicyValueName, change.after);
      applied.policy.push(change.name);
    }
  })();

  plans.delete(id);
  // Open what was added, close what was removed; what watches starts afresh, and looks now.
  await deps.sessions.sync(deps.catalog.list());
  for (const automation of forgotten) deps.engine.forget(automation);
  for (const automation of touched) (deps.engine.reset(automation), deps.engine.poke(automation));
  return applied;
}

/** A device added or changed as its entry says: what it is, how it is reached, its secrets, kept or given. */
function writeDevice(deps: ImportDeps, key: string, entry: DeviceEntry, opened: Map<string, string>, given: Record<string, string>): void {
  const type = deps.types.get(entry.type)!;
  const settings = validateConfig(type.config ?? { fields: {} }, entry.settings);
  if (!settings.ok) throw new ImportError(`${entry.name}: ${settings.issues.map((issue) => issue.message).join('; ')}`);
  const config: ConfigValues = settings.value;
  let device = deps.catalog.byKey(key);
  // One you removed is brought back with its history, not added beside it.
  const back = device ? null : removedMatch(deps, key, entry);
  if (back) device = deps.catalog.update(deps.catalog.restore(back.id)!.id, { key, name: entry.name, config, ...(entry.identity !== null ? { identity: entry.identity } : {}) })!;
  else if (!device) device = deps.catalog.add({ typeId: entry.type, name: entry.name, identity: entry.identity, config, description: type.describe(config as never), key });
  else device = deps.catalog.update(device.id, { name: entry.name, config, ...(entry.identity !== null ? { identity: entry.identity } : {}) })!;
  if (entry.picture !== null && entry.picture !== device.picture) deps.catalog.setPicture(device.id, entry.picture);

  const ways = deps.connections.forDevice(device.id).filter((connection) => connection.heldBy === null);
  entry.connect.forEach((way, index) => {
    const method = methodsOf(type).find((each) => each.id === way.via)!;
    const address = way.address ?? method.address ?? '';
    const had = ways.find((connection) => connection.method === way.via);
    const connection = had
      ? deps.connections.update(had.id, { address, config: way.settings, priority: index, secretsExportable: way.exportable })!
      : deps.connections.add({ deviceId: device!.id, method: way.via, transport: method.transport, heldBy: null, address, config: way.settings, priority: index, secretsExportable: way.exportable });
    const secrets: Record<string, string> = {};
    const credentials = deps.protocols.get(method.protocol)?.credentials?.schema.fields ?? {};
    for (const [field, spec] of Object.entries(credentials)) {
      if (!isSecretField(spec)) continue;
      const value = opened.get(secretKey(key, index, field)) ?? given[`${key}.${field}`];
      if (value) secrets[field] = value;
    }
    if (Object.keys(secrets).length) deps.connections.setSecrets(connection.id, secrets);
  });
  for (const had of ways) if (!entry.connect.some((way) => way.via === had.method)) deps.connections.remove(had.id);
}

