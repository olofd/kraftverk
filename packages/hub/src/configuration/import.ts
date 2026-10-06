import { ApiError, type ImportApplied, type ImportItem, type ImportPlan } from '@kraftverk/api-contract';
import { checkBinding, checkRule, isAutomationRole, isGroupRole, keepsSo, useOf, useText, type AutomationDraft, type BoundPart, type GroupRole, type PartRole, type PartUse } from '@kraftverk/automation';
import type { AutomationEngine, AutomationLibrary, AutomationRecord } from '@kraftverk/automation-engine';
import {
  capabilitiesOf,
  isSimulated,
  MAIN_PART,
  meetsNeed,
  methodsOf,
  partsOf,
  isPolicyValueName,
  POLICY_VALUES,
  randomHex,
  validateConfig,
  type AutomationId,
  type ConfigValues,
  type NodeId,
  type PolicyValueName,
  type SavedDeviceId,
  transportOf,
} from '@kraftverk/device-sdk';
import type { SessionManager } from '@kraftverk/holder';
import {
  checkDocument,
  readConfig,
  type AutomationEntry,
  type ConfigDocument,
  type ConnectEntry,
  type DeviceEntry,
  type SecretValue,
  isSealed,
} from '@kraftverk/home-file';
import { isConstraintError, type ConnectionRecord, type DeviceRecord, type SqlDatabase } from '@kraftverk/store';

import type { Checked } from '../automations/drafts.ts';
import { secretFieldsOf } from '../installed/connection-schema.ts';
import type { TransportHost } from '../installed/transports.ts';
import { unref } from '../timers.ts';
import { homeVocabulary, type ConfigDeps } from './export.ts';
import { isKept, openKept } from './seal.ts';

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
  the home's own, and what acted acts again.
*/

export type ImportDeps = ConfigDeps & {
  /** Where the home is kept: an apply is one transaction. */
  db: SqlDatabase;
  /** The plans made and not yet applied: the hub's own, swept as they expire. */
  pending: PendingPlans;
  sessions: Pick<SessionManager, 'sync'>;
  /** Whether a transport's addresses belong to one device each. */
  transports: Pick<TransportHost, 'definition'>;
  library: AutomationLibrary;
  engine: Pick<AutomationEngine, 'reset' | 'poke' | 'forget'>;
  /** The automation checks the API applies to an automation made or changed (`automations/plans.ts`). */
  checked: (draft: AutomationDraft, self: AutomationId | null) => Checked;
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
  /** Planned as a restore is: what it cannot carry — a secret, a part — is left out and said, never asked for. */
  lenient: boolean;
};

const PLAN_TTL_MS = 15 * 60_000;

/**
 * The plans a home has made and not yet applied, each with the secrets it
 * opened. Forgotten past their time — and those secrets with them — on every
 * use, and each minute besides, so an opened key does not wait in memory for
 * the next import to be made. One per home: nothing at module level.
 */
export class PendingPlans {
  #plans = new Map<string, Kept>();
  /** Each minute, only while a plan waits: made, nothing runs. */
  #sweeper: ReturnType<typeof setInterval> | null = null;

  forgetExpired(now = Date.now()): void {
    for (const [id, kept] of this.#plans) if (kept.expiresAt < now) this.delete(id);
  }

  get(id: string): Kept | undefined {
    this.forgetExpired();
    return this.#plans.get(id);
  }

  set(id: string, kept: Kept): void {
    this.forgetExpired();
    this.#plans.set(id, kept);
    this.#sweepWhileNeeded();
  }

  /** Used up: its opened secrets go with it. */
  delete(id: string): void {
    this.#plans.get(id)?.secrets.clear();
    this.#plans.delete(id);
    this.#sweepWhileNeeded();
  }

  /** Every plan forgotten, and with them the sweeping: the home is stopping. */
  stop(): void {
    for (const id of [...this.#plans.keys()]) this.delete(id);
  }

  #sweepWhileNeeded(): void {
    if (this.#plans.size && !this.#sweeper) {
      this.#sweeper = setInterval(() => this.forgetExpired(), 60_000);
      unref(this.#sweeper);
    } else if (!this.#plans.size && this.#sweeper) {
      clearInterval(this.#sweeper);
      this.#sweeper = null;
    }
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const secretKey = (device: string, index: number, field: string) => `${device}.${index}.${field}`;

/**
 * What importing a file would do. `kept`: the snapshot's own secrets, sealed
 * with this home's key, are opened as the home opens them.
 */
export async function planImport(deps: ImportDeps, text: string, options: { mode: ImportMode; passphrase?: string; by: string; kept?: boolean; lenient?: boolean }): Promise<ImportPlan> {
  const vocabulary = homeVocabulary(deps);
  // A restore reads what it can: an entry it cannot read is left out and said, never the whole home lost for it.
  // A file kept before an installed integration's entries changed comes back as they are now.
  const read = readConfig(text, (document) => checkDocument(document, vocabulary, { hasSecret: () => true, uses: 'leave' }), { partial: options.lenient, migrations: deps.types.fileMigrations() });
  const empty: ImportPlan = { id: null, from: read.from, problems: read.problems.map((each) => ({ ...each, path: [...each.path] })), devices: [], links: [], automations: [], policy: [], location: null, needs: { passphrase: null, secrets: [], rebind: [], confirm: [] }, notes: [] };
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

  // Secrets: opened now — those sealed with a passphrase first, as sealing takes its time — or said to be needed.
  const unsealed = new Map<string, string | null>();
  if (options.passphrase) {
    for (const value of sealedIn(document)) {
      if (unsealed.has(value)) continue;
      unsealed.set(value, await deps.sealing.open(options.passphrase, value).catch(() => null));
    }
  }
  const open = (value: string): string | null => {
    if (isKept(value)) return options.kept ? openKept(deps.kept, value) : null;
    if (!isSealed(value)) return value;
    if (!options.passphrase) {
      needs.passphrase = 'missing';
      return null;
    }
    const opened = unsealed.get(value) ?? null;
    if (opened === null) needs.passphrase = 'wrong';
    return opened;
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
      // A member's key is one member of its bridge — a bridge the file brings is new, and claimed by nothing yet.
      const bridge = way.through !== null ? (deps.catalog.byKey(way.through)?.id ?? null) : null;
      // An address belongs to one device where its transport says so — never a simulator's, which every simulated device shares — as setup decides it.
      const exclusive = !isSimulated(method) && deps.transports.definition(method.transport)?.exclusive !== false;
      const claim = way.through !== null ? (bridge ? deps.connections.member(bridge, address) : null) : exclusive ? deps.connections.claimant(transportOf(method), address) : null;
      if (claim && claim.deviceId !== existing?.id) problem(way.through !== null ? `Another device you have is already ${address} behind ${way.through}` : `Another device you have is already reached at ${address}`, ['devices', key, 'connect', index, 'address']);
      const had = existing ? governed(deps, existing.id).find((connection) => sameWay(deps, connection, way)) : undefined;
      for (const [field, spec] of secretFieldsOf(method, deps.protocols.get(method.protocol) ?? null)) {
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
    if (entry.recheckMinutes !== null && !keepsSo(entry.rule)) problem('Only an automation that waits for a condition, and does what it does at once, can keep things so ("recheck")', [...path, 'recheck']);
    // A role nothing fills — a rule written while it was being built — cannot run: said where it is.
    for (const [role, spec] of Object.entries(entry.rule.roles)) if (!entry.uses[role]) problem(`${spec.label}: nothing fills it — name ${isAutomationRole(spec) ? 'an automation' : 'a device'} for it`, [...path, 'uses', role]);
    /** Whether a device is here, or the file brings it. */
    const known = (device: string) => Boolean((document.devices[device] && !leftOut.has(device)) || deps.catalog.byKey(device));
    for (const [role, use] of Object.entries(entry.uses)) {
      const spec = entry.rule.roles[role];
      if ('automation' in use) {
        if (!document.automations[use.automation] && !deps.automations.byKey(use.automation)) problem(`There is no automation "${use.automation}", in the file or here`, [...path, 'uses', role]);
        continue;
      }
      // A group's parts, each where it is in its list: one not here is said, not chosen again.
      if ('parts' in use) {
        use.parts.forEach((part, index) => {
          if (!known(part.device)) problem(`${spec?.label ?? role}: "${useText(part)}" is not here`, [...path, 'uses', role, index]);
        });
        continue;
      }
      if (known(use.device)) continue;
      // A device you do not have: one of yours that can do what the role needs — or, restoring, nothing yet.
      const need = spec && !isAutomationRole(spec) && !isGroupRole(spec) ? spec : null;
      if (options.lenient) problem(`${spec?.label ?? role}: "${useText(use)}" is not here`, [...path, 'uses', role]);
      else needs.rebind.push({ automation: key, role, label: spec?.label ?? role, wanted: useText(use), candidates: candidatesFor(deps, need, document) });
    }
    // What fills each part, checked as the apply will: a part that cannot do what its role needs is said now, not after a yes.
    for (const said of bindingProblems(deps, entry, document, leftOut)) problem(said.message, [...path, ...said.path]);
    const existing = deps.automations.byKey(key);
    const acts = entry.mode === 'act' && (!existing || existing.mode !== 'act' || !same(existing.rule, entry.rule) || existing.recheckMinutes !== entry.recheckMinutes);
    if (acts) needs.confirm.push(`"${entry.name}" will act on its own${existing?.mode === 'act' ? ', doing what the file says' : ''}`);
    automations.push(existing ? { key, name: entry.name, ...automationChanges(deps, existing, entry) } : { key, name: entry.name, action: 'add', changes: [] });
  }

  // The home's values.
  const now = deps.policy.values();
  /*
    Each value is one this version knows, within its bounds: a file from another
    version may name one renamed or gone, or one whose bounds have narrowed.
    A restore leaves it out and says so; an import a person reads stops at it.
  */
  const fits = ([name, value]: [string, number | null]): boolean => {
    if (!isPolicyValueName(name)) {
      if (options.lenient) notes.push(`The home's value "${name}" is left out: this version has no such value`);
      else problems.push({ message: `The home has no value called "${name}"`, path: ['home', 'policy', name], line: null, column: null });
      return false;
    }
    const spec = POLICY_VALUES[name];
    if (value !== null && !(value >= spec.min && value <= spec.max)) {
      const said = `${spec.label} is from ${spec.min} to ${spec.max} ${spec.unit}, not ${value}`;
      if (options.lenient) notes.push(`The home's value "${name}" is left out: ${said}`);
      else problems.push({ message: said, path: ['home', 'policy', name], line: null, column: null });
      return false;
    }
    return true;
  };
  const policy = Object.entries(document.home.policy)
    .filter(fits)
    .filter(([name, value]) => now[name as PolicyValueName] !== value)
    .map(([name, value]) => ({ name, label: POLICY_VALUES[name as PolicyValueName].label, before: now[name as PolicyValueName] ?? null, after: value }));
  // Where the home is: set when the file says it, and it is not so already. A file that says none leaves it as it is.
  const here = deps.location.get();
  const said = document.home.location;
  const location = said && (said.latitude !== here?.latitude || said.longitude !== here?.longitude) ? { before: here, after: said } : null;

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
  const id = placed.length ? null : `p-${randomHex(12)}`;
  const view: ImportPlan = { id, from: read.from, problems: placed, devices, links, automations, policy, location, needs, notes };
  if (id) deps.pending.set(id, { view, document, mode: options.mode, secrets, by: options.by, expiresAt: Date.now() + PLAN_TTL_MS, turnedOff, lenient: Boolean(options.lenient) });
  return view;
}

/** Every value in a file sealed with a passphrase: in its secrets, or written in place. */
function sealedIn(document: ConfigDocument): string[] {
  const inPlace = Object.values(document.devices).flatMap((entry) => entry.connect.flatMap((way) => Object.values(way.secrets).flatMap((secret) => ('sealed' in secret ? [secret.sealed] : []))));
  return [...Object.values(document.secrets), ...inPlace].filter(isSealed);
}

/** Where a path is in the text: the reader's own placing, for problems the plan finds after reading. */
function locate(text: string, path: (string | number)[]): { line: number | null; column: number | null } {
  const placed = readConfig(text, () => [{ message: '', path }]).problems[0];
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
  const bound = new Map<string, BoundPart[]>();
  /** One part filling a role — the role's, or one of its group's — as it will be: null when it is not known, or cannot do what the role needs (said). */
  const partOf = (spec: PartRole | GroupRole, use: PartUse, path: (string | number)[]): BoundPart | null => {
    const brought = leftOut.has(use.device) ? undefined : document.devices[use.device];
    const here = deps.catalog.byKey(use.device);
    // The file's own word on it first: what it will be once imported.
    const description = brought ? deps.types.get(brought.type)?.describe(brought.settings as never) : here?.description;
    const name = brought?.name ?? here?.name;
    if (!description || !name) return null;
    if (!partsOf(description).some((part) => part.id === use.part)) {
      found.push({ message: `${spec.label}: ${name} has no part "${use.part}"`, path });
      return null;
    }
    const capabilities = capabilitiesOf(description, use.part);
    if (!meetsNeed(spec, capabilities)) {
      found.push({ message: `${spec.label}: that part of ${name} cannot do what it needs (${spec.capabilities.join(', ')})`, path });
      return null;
    }
    return { name: use.part === MAIN_PART ? name : `${name} — ${use.part}`, description, part: use.part, capabilities };
  };
  for (const [role, spec] of Object.entries(entry.rule.roles)) {
    const use = entry.uses[role];
    if (isAutomationRole(spec) || !use || 'automation' in use) continue;
    const uses = 'parts' in use ? use.parts : [use];
    const parts = uses.flatMap((each, index) => {
      const part = partOf(spec, each, 'parts' in use ? ['uses', role, index] : ['uses', role]);
      return part ? [part] : [];
    });
    if (parts.length) bound.set(role, parts);
  }
  // What the filled parts must report and let be written: once the rule itself holds.
  if (checkRule(entry.rule, deps.library).length) return found;
  const filled = Object.fromEntries(Object.entries(entry.rule.roles).filter(([role, spec]) => !isAutomationRole(spec) && bound.has(role)));
  for (const said of checkBinding({ ...entry.rule, roles: filled }, (role) => bound.get(role) ?? [])) found.push({ message: said, path: [] });
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
      .map((part) => ({ use: useText({ device: device.key, part: part.id }), name: part.id === MAIN_PART ? device.name : `${device.name} — ${part.label}` }))
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
  const ways = governed(deps, existing.id);
  entry.connect.forEach((way, index) => {
    const had = ways.find((connection) => sameWay(deps, connection, way));
    if (!had) changes.push(`reached ${way.via} as well`);
    else {
      if (way.address !== null && had.address !== way.address) changes.push(`${way.via}: at ${way.address}, not ${had.address}`);
      if (!same(had.config, { ...had.config, ...way.settings })) changes.push(`${way.via}: its settings`);
      const fields = deps.connections.secretFields(had.id);
      if (had.secretsExportable !== way.exportable && (!way.exportable || fields.every((field) => secrets.has(secretKey(key, index, field)))))
        changes.push(`${way.via}: its secrets ${way.exportable ? 'may' : 'may no longer'} leave in plain text`);
      for (const field of fields) {
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
  if (existing.mode !== entry.mode) changes.push(`${existing.mode} → ${entry.mode}`);
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
export function keptPlan(deps: Pick<ImportDeps, 'pending'>, id: string, by: string): ImportPlan | null {
  const kept = deps.pending.get(id);
  return kept && kept.by === by && kept.expiresAt > Date.now() ? kept.view : null;
}

/** A plan written: what it did, and what is set going after (`startWritten`). */
export type Written = { applied: ImportApplied; touched: AutomationId[]; forgotten: AutomationId[] };

/**
 * Writes a plan, with its answers, in one transaction — or nothing, and why.
 * The plan is used up. Confirmation is the caller's: what it asks a yes to is
 * in the plan's `needs.confirm`. Only what the file asks is refused as
 * invalid — an answer missing, a row the database will not keep; a fault in
 * the code goes on as one.
 */
export function writeImport(deps: ImportDeps, id: string, by: string, choices: ImportChoices, options: { lenient?: boolean } = {}): Written {
  const kept = deps.pending.get(id);
  if (!kept || kept.by !== by || kept.expiresAt < Date.now()) throw new ApiError('not-found', 'That plan has gone: read the file again');
  const { document, view } = kept;
  // A plan made as a restore is applied as one.
  options = { lenient: options.lenient ?? kept.lenient };
  if (view.needs.passphrase) throw new ApiError('invalid', view.needs.passphrase === 'missing' ? 'Give the passphrase its secrets are sealed with' : 'The passphrase does not open its secrets');
  const devicesIn = (key: string) => !choices.include?.devices || choices.include.devices.includes(key);
  const automationsIn = (key: string) => !choices.include?.automations || choices.include.automations.includes(key);

  // Every answer it asked for.
  const missing: string[] = [];
  // A restore asks nothing: a device whose secret is gone is restored without it.
  if (!options.lenient) for (const need of view.needs.secrets) if (devicesIn(need.device) && !choices.secrets?.[`${need.device}.${need.field}`]) missing.push(`${need.deviceName}: its ${need.title}`);
  if (!options.lenient) for (const need of view.needs.rebind) if (automationsIn(need.automation) && !choices.rebind?.[`${need.automation}.${need.role}`]) missing.push(`"${document.automations[need.automation]?.name}": a device for ${need.label}`);
  if (missing.length) throw new ApiError('invalid', `It still needs ${missing.join('; ')}`, { problems: missing });

  const applied: ImportApplied = { devices: { added: [], restored: [], changed: [], removed: [] }, automations: { added: [], changed: [], removed: [] }, links: { added: 0, removed: 0 }, policy: [], location: false, notes: [] };
  const touched: AutomationId[] = [];
  /** Where each automation goes on the home page: placed after all are written, by place, so each lands where the file says. */
  const placing: { id: AutomationId; place: number | null }[] = [];
  /** Restoring, each in a savepoint of its own: what fails is undone alone, said, and the rest goes on. */
  const each = (what: string, work: () => void) => {
    if (!options.lenient) return work();
    try {
      deps.db.transaction(work)();
    } catch (error) {
      applied.notes.push(`${what} could not be restored: ${error instanceof ApiError && error.problems.length ? error.problems.join('; ') : (error as Error).message}`);
    }
  };
  const forgotten: AutomationId[] = [];

  try {
    deps.db.transaction(() => {
      // Devices: added, changed, removed — a bridge before what is reached through it.
      for (const item of bridgesFirst(view.devices, document)) {
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
        const id = existing?.id ?? deps.automations.create({ key: item.key, name: entry.name, rule: entry.rule, madeFrom: entry.madeFrom, roles: {}, groups: {}, starts: {}, timeZone: entry.clock, recheckMinutes: entry.recheckMinutes }).id;
        written.push({ key: item.key, entry, id, existing });
      }
      for (const { key, entry, id, existing } of written) {
        const roles: Record<string, { device: SavedDeviceId; part: string }> = {};
        const groups: Record<string, { device: SavedDeviceId; part: string }[]> = {};
        const starts: Record<string, AutomationId> = {};
        for (const [role, use] of Object.entries(entry.uses)) {
          if ('automation' in use) {
            const other = deps.automations.byKey(use.automation);
            if (other) starts[role] = other.id;
            continue;
          }
          // A group: each part that is here, in order.
          if ('parts' in use) {
            groups[role] = use.parts.flatMap((part) => {
              const device = deps.catalog.byKey(part.device);
              return device ? [{ device: device.id, part: part.part }] : [];
            });
            continue;
          }
          const named = deps.catalog.byKey(use.device) ? use : useOf(choices.rebind?.[`${key}.${role}`] ?? '');
          const device = named ? deps.catalog.byKey(named.device) : null;
          if (device && named) roles[role] = { device: device.id, part: named.part };
        }
        const result = deps.checked({ rule: entry.rule, roles, groups, starts }, id);
        // Restoring, one that cannot be kept as it was is kept turned off — its rule, what still fills it — and said: its owner's work is not lost.
        const why = [...new Set([...(kept.turnedOff.get(key) ?? []), ...result.problems])];
        if (why.length && !options.lenient) throw new ApiError('invalid', `"${entry.name}" cannot be kept as it is`, { problems: why.map((said) => `"${entry.name}": ${said}`) });
        each(`"${entry.name}"`, () => {
          deps.automations.update(id, { name: entry.name, rule: entry.rule, roles: result.roles, groups: result.groups, starts: result.starts, timeZone: entry.clock, mode: why.length ? 'off' : entry.mode, recheckMinutes: entry.recheckMinutes });
          if (entry.homePlace !== (existing?.homePlace ?? null)) placing.push({ id, place: entry.homePlace });
          (existing ? applied.automations.changed : applied.automations.added).push(key);
          if (why.length) applied.notes.push(`"${entry.name}" is restored turned off: ${why.join('; ')}`);
          touched.push(id);
        });
      }

      // The home page, in the order of its places: one put first, then the next after it, each where the file says.
      for (const { id } of placing.filter((each) => each.place === null)) deps.automations.placeOnHome(id, null);
      for (const { id, place } of placing.filter((each) => each.place !== null).sort((a, b) => a.place! - b.place!)) deps.automations.placeOnHome(id, place);

      // The home's values.
      for (const change of view.policy) {
        deps.policy.set(change.name as PolicyValueName, change.after);
        applied.policy.push(change.name);
      }
      if (view.location) {
        deps.location.set(view.location.after);
        applied.location = true;
      }
    })();
  } catch (error) {
    // The database would not keep a row of it: the file's, said as a refusal, and nothing was written.
    throw isConstraintError(error) ? new ApiError('invalid', (error as Error).message) : error;
  }

  // Used up: its opened secrets go with it.
  deps.pending.delete(id);
  return { applied, touched, forgotten };
}

/** Sets going what an import wrote: what was added opened, what was removed closed; what watches starts afresh, and looks now. */
export async function startWritten(deps: ImportDeps, written: Written): Promise<void> {
  /*
    At once, before anything is awaited: a hold of the rule that was, or a
    look at what it watched, is the new rule's no more — and a tick while
    the devices open would otherwise fire it, and the look after them again.
  */
  for (const automation of written.forgotten) deps.engine.forget(automation);
  for (const automation of written.touched) deps.engine.reset(automation);
  await deps.sessions.sync(deps.catalog.list());
  for (const automation of written.touched) deps.engine.poke(automation);
}

/** A device added or changed as its entry says: what it is, how it is reached, its secrets, kept or given. */
function writeDevice(deps: ImportDeps, key: string, entry: DeviceEntry, opened: Map<string, string>, given: Record<string, string>): void {
  const type = deps.types.get(entry.type)!;
  const settings = validateConfig(type.config ?? { fields: {} }, entry.settings);
  if (!settings.ok) throw new ApiError('invalid', `${entry.name}: ${settings.issues.map((issue) => issue.message).join('; ')}`);
  const config: ConfigValues = settings.value;
  let device = deps.catalog.byKey(key);
  // One you removed is brought back with its history, not added beside it.
  const back = device ? null : removedMatch(deps, key, entry);
  if (back) device = deps.catalog.update(deps.catalog.restore(back.id)!.id, { key, name: entry.name, config, ...(entry.identity !== null ? { identity: entry.identity } : {}) })!;
  else if (!device) device = deps.catalog.add({ typeId: entry.type, name: entry.name, identity: entry.identity, config, description: type.describe(config as never), key });
  else device = deps.catalog.update(device.id, { name: entry.name, config, ...(entry.identity !== null ? { identity: entry.identity } : {}) })!;
  if (entry.picture !== null && entry.picture !== device.picture) deps.catalog.setPicture(device.id, entry.picture);

  const ways = governed(deps, device.id);
  entry.connect.forEach((way, index) => {
    const method = methodsOf(type).find((each) => each.id === way.via)!;
    const address = way.address ?? method.address ?? '';
    const had = ways.find((connection) => sameWay(deps, connection, way));
    const secrets: Record<string, string> = {};
    for (const [field] of secretFieldsOf(method, deps.protocols.get(method.protocol) ?? null)) {
      const value = opened.get(secretKey(key, index, field)) ?? given[`${key}.${field}`];
      if (value) secrets[field] = value;
    }
    /*
      Letting a kept secret leave in plain text asks for your password (the
      server's route): a file does not, so it turns that on only for secrets
      it brings itself — what it already holds. Turning it off it may always.
    */
    const exportable = way.exportable && (!had || had.secretsExportable || deps.connections.secretFields(had.id).every((field) => field in secrets));
    const connection = had
      ? deps.connections.update(had.id, { address, config: way.settings, priority: index, secretsExportable: exportable })!
      : deps.connections.add({ deviceId: device!.id, method: way.via, transport: transportOf(method), ...holdingOf(deps, way), address, config: way.settings, priority: index, secretsExportable: exportable });
    if (Object.keys(secrets).length) deps.connections.setSecrets(connection.id, secrets);
  });
  for (const had of ways) if (!entry.connect.some((way) => sameWay(deps, had, way))) deps.connections.remove(had.id);
}

/**
 * The devices of a plan in the order they are written: a bridge the file
 * brings before what the file reaches through it, however deep — so a way
 * through it names a device that is there.
 */
function bridgesFirst<T extends { key: string }>(items: readonly T[], document: ConfigDocument): T[] {
  const depth = (key: string, seen: ReadonlySet<string> = new Set()): number => {
    const bridges = (document.devices[key]?.connect ?? []).flatMap((way) => (way.through !== null && way.through in document.devices && !seen.has(way.through) ? [way.through] : []));
    return bridges.length ? 1 + Math.max(...bridges.map((bridge) => depth(bridge, new Set([...seen, key])))) : 0;
  };
  return items.map((item, index) => ({ item, index, depth: depth(item.key) })).sort((a, b) => a.depth - b.depth || a.index - b.index).map(({ item }) => item);
}

/** The ways a file speaks for: those this node holds, and those through a bridge — never another node's own. */
function governed(deps: ImportDeps, deviceId: SavedDeviceId): ConnectionRecord[] {
  return deps.connections.forDevice(deviceId).filter((connection) => connection.heldBy === deps.self || connection.through !== null);
}

/** Whether a way the home has is the one a file's entry names: its method, and — through a bridge — that bridge. */
function sameWay(deps: ImportDeps, connection: ConnectionRecord, way: ConnectEntry): boolean {
  if (connection.method !== way.via) return false;
  if (way.through === null) return connection.through === null;
  return connection.through !== null && connection.through === deps.catalog.byKey(way.through)?.id;
}

/** Who has a way the file brings in hand: this node, or the bridge it names — written before it, as the file's bridges are. */
function holdingOf(deps: ImportDeps, way: ConnectEntry): { heldBy: NodeId } | { through: SavedDeviceId } {
  if (way.through === null) return { heldBy: deps.self };
  const bridge = deps.catalog.byKey(way.through);
  if (!bridge) throw new ApiError('invalid', `There is no device "${way.through}" to reach it through`);
  return { through: bridge.id };
}

