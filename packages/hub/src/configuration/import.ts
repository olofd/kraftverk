import { ApiError, type DevicePeople, type ImportApplied, type ImportItem, type ImportPlan, type LabelTarget, type PlacementInput } from '@kraftverk/api-contract';
import { checkBinding, checkRule, isAutomationRole, isPartRole, isPeopleRole, isPersonRole, isPlaceRole, isScriptRole, isWorldRole, keepsSo, sameFill, useOf, useText, type AutomationDraft, type RuleVocabulary, type BoundPart, type GroupRole, type PartRole, type PartUse, type Use, type WorldFill, type WorldUse } from '@kraftverk/automation';
import type { AutomationEngine, AutomationLibrary, AutomationRecord } from '@kraftverk/automation-engine';
import { standingProblem, turnOf } from '@kraftverk/map/limits';
import {
  capabilitiesOf,
  isSessionKept,
  isSimulated,
  MAIN_PART,
  meetsNeed,
  methodsOf,
  partsOf,
  isPolicyValueName,
  POLICY_VALUES,
  newId,
  sameActor,
  type Actor,
  validateConfig,
  type AutomationId,
  type ConfigValues,
  type NodeId,
  type PolicyValueName,
  type PolicyValues,
  type SavedDeviceId,
  transportOf,
  checkValue,
  valueTypeOf,
} from '@kraftverk/device-sdk';
import type { SessionManager } from '@kraftverk/holder';
import {
  checkDocument,
  readConfig,
  type AutomationEntry,
  type ConfigDocument,
  type ConnectEntry,
  type DeviceEntry,
  type DevicePeopleEntry,
  type HomeEntry,
  type PlaceEntry,
  type SecretValue,
  type SpaceEntry,
  isSealed,
  SITE_KEY,
} from '@kraftverk/home-file';
import { checkChain, fromBase64url, type Statement } from '@kraftverk/identity';
import { HOME_RADIUS, ZONE_RADIUS, isConstraintError, type ConnectionRecord, type DeviceRecord, type SqlDatabase } from '@kraftverk/store';

import type { Checked } from '../automations/drafts.ts';
import { bySource, secretFieldsOf } from '../installed/connection-schema.ts';
import type { TransportHost } from '../installed/transports.ts';
import { unref } from '../timers.ts';
import { homeVocabulary, placeOf, type ConfigDeps } from './export.ts';
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
  by: Actor;
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
export async function planImport(deps: ImportDeps, text: string, options: { mode: ImportMode; passphrase?: string; by: Actor; kept?: boolean; lenient?: boolean }): Promise<ImportPlan> {
  const vocabulary = homeVocabulary(deps);
  // A restore reads what it can: an entry it cannot read is left out and said, never the whole home lost for it.
  // A file kept before an installed integration's entries changed comes back as they are now.
  const read = readConfig(text, (document) => checkDocument(document, vocabulary, { hasSecret: () => true, uses: 'leave' }), { partial: options.lenient, migrations: deps.types.fileMigrations() });
  const empty: ImportPlan = { id: null, from: read.from, problems: read.problems.map((each) => ({ ...each, path: [...each.path] })), devices: [], links: [], automations: [], family: [], people: [], homes: [], labels: [], scripts: [], zones: [], modes: [], policy: [], needs: { passphrase: null, secrets: [], rebind: [], confirm: [] }, notes: [] };
  if (!read.document) return empty;
  const document = read.document;
  // What a device it brings is, with its settings, is its type's code to say: each type it names is loaded now.
  await Promise.all([...new Set(Object.values(document.devices).map((entry) => entry.type))].map((type) => deps.types.load(type)));
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
  /** Devices whose place, restoring, is left as it is. */
  const placesLeft = new Set<string>();
  /** Labels a thing names that are nowhere: a problem — restoring, left off and said. */
  const labelsKnown = (keys: readonly string[], path: (string | number)[], what: string) => {
    for (const key of keys)
      if (!document.labels[key] && !deps.labels.byKey(key)) {
        if (options.lenient) notes.push(`${what}: the label "${key}" is left off: there is no such label`);
        else problems.push({ message: `There is no label "${key}", in the file or here`, path, line: null, column: null });
      }
  };

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
        // What its session keeps, it keeps again: never asked of a person.
        else if (!isSessionKept(spec) && (given || spec.required)) needs.secrets.push({ device: key, deviceName: entry.name, field, title: spec.title });
      }
    });
    // Where it stands: a home, a space and an opening the file brings or you have. Restoring, one that is not is left as it is, and said.
    labelsKnown(entry.labels, ['devices', key, 'labels'], key);
    const misplaced = entry.place ? placeProblem(deps, document, entry.place) : null;
    if (misplaced && options.lenient) (notes.push(`${key}: where it stands is left as it is: ${misplaced}`), placesLeft.add(key));
    else if (misplaced) problem(misplaced, ['devices', key, entry.place!.role === 'based' ? 'based' : 'place']);
    if (leftOut.has(key)) continue;
    const back = existing ? null : removedMatch(deps, key, entry);
    devices.push(existing ? { key, name: entry.name, ...deviceChanges(deps, existing, placesLeft.has(key) ? { ...entry, place: null } : entry, secrets, key, (personKey) => document.people[personKey]?.id ?? null) } : { key, name: entry.name, action: back ? 'restore' : 'add', changes: back ? [`brought back, with its history (removed ${back.removedAt!.slice(0, 10)})`] : [] });
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
    for (const said of checkRule(entry.rule, ruleVocabularyOf(deps, document))) problem(said, path);
    if (entry.recheckMinutes !== null && !keepsSo(entry.rule)) problem('Only an automation that waits for a condition, and does what it does at once, can keep things so ("recheck")', [...path, 'recheck']);
    // A role nothing fills — a rule written while it was being built — cannot run: said where it is.
    for (const [role, spec] of Object.entries(entry.rule.roles))
      if (!entry.uses[role]) problem(`${spec.label}: nothing fills it — name ${isAutomationRole(spec) ? 'an automation' : isPersonRole(spec) ? 'a person' : isPeopleRole(spec) ? 'people' : isPlaceRole(spec) ? 'a place' : 'a device'} for it`, [...path, 'uses', role]);
    /** Whether a device is here, or the file brings it. */
    const known = (device: string) => Boolean((document.devices[device] && !leftOut.has(device)) || deps.catalog.byKey(device));
    for (const [role, use] of Object.entries(entry.uses)) {
      const spec = entry.rule.roles[role];
      if ('automation' in use) {
        if (!document.automations[use.automation] && !deps.automations.byKey(use.automation)) problem(`There is no automation "${use.automation}", in the file or here`, [...path, 'uses', role]);
        continue;
      }
      if ('script' in use) {
        if (!document.scripts[use.script] && !deps.scripts.store.byKey(use.script)) problem(`There is no script "${use.script}", in the file or here`, [...path, 'uses', role]);
        continue;
      }
      // A person, people, a place: in the file, or here.
      if (isWorldUse(use)) {
        for (const missing of worldMissing(deps, document, entry, use)) problem(`${spec?.label ?? role}: ${missing}`, [...path, 'uses', role]);
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
      const need = spec && isPartRole(spec) ? spec : null;
      if (options.lenient) problem(`${spec?.label ?? role}: "${useText(use)}" is not here`, [...path, 'uses', role]);
      else needs.rebind.push({ automation: key, role, label: spec?.label ?? role, wanted: useText(use), candidates: candidatesFor(deps, need, document) });
    }
    // What fills each part, checked as the apply will: a part that cannot do what its role needs is said now, not after a yes.
    for (const said of bindingProblems(deps, entry, document, leftOut)) problem(said.message, [...path, ...said.path]);
    labelsKnown(entry.labels, [...path, 'labels'], key);
    const existing = deps.automations.byKey(key);
    const acts = entry.mode === 'act' && (!existing || existing.mode !== 'act' || !same(existing.rule, entry.rule) || existing.recheckMinutes !== entry.recheckMinutes);
    if (acts) needs.confirm.push(`"${entry.name}" will act on its own${existing?.mode === 'act' ? ', doing what the file says' : ''}`);
    automations.push(existing ? { key, name: entry.name, ...automationChanges(deps, document, existing, entry) } : { key, name: entry.name, action: 'add', changes: [] });
  }

  // The family itself: what the file says of it, where that is not so.
  const familyNow = deps.family.get();
  const family: string[] = [];
  if (familyNow && document.family.name !== null && document.family.name !== familyNow.name) family.push(`name: ${familyNow.name} → ${document.family.name}`);
  if (familyNow && document.family.kind !== null && document.family.kind !== familyNow.kind) family.push(`kind: ${familyNow.kind} → ${document.family.kind}`);
  if (familyNow && document.family.locale !== null && document.family.locale !== familyNow.locale) family.push(`language: ${familyNow.locale} → ${document.family.locale}`);

  // Its people, by id: each chain checked again, and a newer one than this family has taken; what the family calls each, their colour and role.
  const people: ImportItem[] = Object.entries(document.people).flatMap(([key, entry]): ImportItem[] => {
    const chain = chainOf(entry.chain);
    const checked = chain ? checkChain(chain) : null;
    const said = !chain || !checked?.ok ? 'is not who the file says: their chain does not check' : checked.person.id !== entry.id ? 'is someone else: their chain names another id' : null;
    const kept = deps.people.chainOf(entry.id);
    const older = said === null && chain !== null && kept.length > chain.length;
    if (said) {
      if (options.lenient) notes.push(`${entry.name} is left out: they ${said}`);
      else problems.push({ message: `${entry.name} ${said}`, path: ['people', key, 'chain'], line: null, column: null });
      return [];
    }
    const existing = deps.people.get(entry.id);
    if (!existing?.member) return [{ key, name: entry.name, action: 'add', changes: [] }];
    const changes: string[] = [];
    if (!older && chain!.length > kept.length) changes.push('who they are: a newer copy');
    if (entry.role !== existing.member.role) changes.push(`${existing.member.role} → ${entry.role}`);
    if (entry.nickname !== null && entry.nickname !== existing.member.nickname) changes.push(`called ${entry.nickname}`);
    if (entry.color !== null && entry.color !== existing.member.color) changes.push('their colour');
    if (entry.sharing && (entry.sharing.level !== existing.member.sharing.level || entry.sharing.keepDays !== existing.member.sharing.keepDays)) changes.push('what they share');
    if (entry.shortcuts.join() !== deps.shortcuts.of(entry.id).map((id) => deps.automations.get(id)?.key).join()) changes.push('their shortcuts');
    return [{ key, name: entry.name, action: changes.length ? 'change' : 'same', changes }];
  });

  // Its scripts, by key: each read by this place's engine, as a script kept here is — added, changed, or the same.
  // Restoring keeps one that does not read here as it is, and says so: its source is the family's, whatever this engine makes of it.
  const scripts: ImportItem[] = Object.entries(document.scripts).map(([key, entry]) => {
    if (deps.scripts.engine) {
      const { problems: found } = deps.scripts.read(entry.source);
      for (const each of found) {
        const said = `The script "${entry.name}": ${each.line ? `line ${each.line}${each.column ? `, column ${each.column}` : ''}: ` : ''}${each.message}`;
        if (options.lenient) notes.push(`${said} — kept as it is`);
        else problems.push({ message: said, path: ['scripts', key, 'source'], line: null, column: null });
      }
    } else notes.push(`The script "${entry.name}" is kept as it is: this place has no engine to read it`);
    const existing = deps.scripts.store.byKey(key);
    if (!existing) return { key, name: entry.name, action: 'add', changes: [] };
    const changes: string[] = [];
    if (existing.name !== entry.name) changes.push(`name: ${existing.name} → ${entry.name}`);
    if (existing.source !== entry.source) changes.push('what it says');
    return { key, name: entry.name, action: changes.length ? 'change' : 'same', changes };
  });

  // Its labels, by key: added, or renamed and coloured as the file says.
  const labels: ImportItem[] = Object.entries(document.labels).map(([key, entry]) => {
    const existing = deps.labels.byKey(key);
    if (deps.labels.nameTaken(entry.name, existing?.id)) problems.push({ message: `Another label here is called "${entry.name}"`, path: ['labels', key, 'name'], line: null, column: null });
    if (!existing) return { key, name: entry.name, action: 'add', changes: [] };
    const changes: string[] = [];
    if (existing.name !== entry.name) changes.push(`name: ${existing.name} → ${entry.name}`);
    if (entry.color !== null && entry.color !== existing.color) changes.push('its colour');
    if (entry.icon !== null && entry.icon !== existing.icon) changes.push('its icon');
    return { key, name: entry.name, action: changes.length ? 'change' : 'same', changes };
  });
  for (const [key, entry] of Object.entries(document.homes)) for (const { space } of flatSpaces(entry.spaces)) labelsKnown(space.labels, ['homes', key, 'spaces', space.key, 'labels'], space.name);

  // Its homes, by key: added, or changed where the file says otherwise. What a file does not say — where one is, its address — is left as it is.
  const homes: ImportItem[] = Object.entries(document.homes).map(([key, entry]) => {
    const existing = deps.places.homeByKey(key);
    if (!existing) return { key, name: entry.name, action: 'add', changes: spaceChanges(deps, null, entry) };
    const changes: string[] = [];
    if (existing.name !== entry.name) changes.push(`name: ${existing.name} → ${entry.name}`);
    if (existing.type !== entry.type) changes.push(`a ${entry.type}, not a ${existing.type}`);
    if (existing.timeZone !== entry.timeZone) changes.push(`clock: ${existing.timeZone} → ${entry.timeZone}`);
    const said = entry.location;
    if (said && (said.latitude !== existing.location?.latitude || said.longitude !== existing.location?.longitude)) changes.push(existing.location ? 'where it is' : 'where it is, said');
    if (said && said.radius !== null && said.radius !== existing.location?.radius) changes.push(`its geofence: ${said.radius} m`);
    const address = entry.address;
    if ((Object.keys(address) as (keyof typeof address)[]).some((part) => address[part] !== null && address[part] !== existing.address[part])) changes.push('its address');
    if (entry.country !== null && entry.country !== existing.country) changes.push(`its country: ${entry.country}`);
    if (entry.picture !== null && entry.picture !== existing.pictureId) changes.push('its picture');
    if (entry.icon !== null && entry.icon !== existing.icon) changes.push('its icon');
    if (entry.bearing !== existing.bearing) changes.push(`its bearing: ${entry.bearing}°`);
    changes.push(...spaceChanges(deps, existing.id, entry));
    return changes.length ? { key, name: entry.name, action: 'change', changes } : { key, name: entry.name, action: 'same', changes };
  });

  // Its zones, by key: added, or moved and renamed as the file says.
  const zones: ImportItem[] = Object.entries(document.zones).map(([key, entry]) => {
    const existing = deps.places.zoneByKey(key);
    if (!existing) return { key, name: entry.name, action: 'add', changes: [] };
    const changes: string[] = [];
    if (existing.name !== entry.name) changes.push(`name: ${existing.name} → ${entry.name}`);
    if (entry.location.latitude !== existing.location.latitude || entry.location.longitude !== existing.location.longitude) changes.push('where it is');
    if (entry.location.radius !== null && entry.location.radius !== existing.location.radius) changes.push(`its size: ${entry.location.radius} m`);
    if (entry.icon !== null && entry.icon !== existing.icon) changes.push('its icon');
    return { key, name: entry.name, action: changes.length ? 'change' : 'same', changes };
  });

  // Its own modes, by key: added, or renamed as the file says. A key a mode on the other axis has is a problem.
  const modes: ImportItem[] = Object.entries(document.modes).map(([key, entry]) => {
    const existing = deps.modes.byKey(key);
    if (existing && existing.axis !== entry.axis) problems.push({ message: `"${key}" is a mode of ${existing.axis === 'presence' ? 'presence' : 'the day'} here: a key names one mode`, path: ['modes', key, 'axis'], line: null, column: null });
    if (!existing) return { key, name: entry.name, action: 'add', changes: [] };
    const changes: string[] = [];
    if (existing.name !== entry.name) changes.push(`name: ${existing.name} → ${entry.name}`);
    if (entry.icon !== null && entry.icon !== existing.icon) changes.push('its icon');
    return { key, name: entry.name, action: changes.length ? 'change' : 'same', changes };
  });

  // Each home's values.
  /*
    Each value is one this version knows, within its bounds: a file from another
    version may name one renamed or gone, or one whose bounds have narrowed.
    A restore leaves it out and says so; an import a person reads stops at it.
  */
  let homeKey = '';
  const fits = ([name, value]: [string, number | null]): boolean => {
    if (!isPolicyValueName(name)) {
      if (options.lenient) notes.push(`A home's value "${name}" is left out: this version has no such value`);
      else problems.push({ message: `A home has no value called "${name}"`, path: ['homes', homeKey, 'policy', name], line: null, column: null });
      return false;
    }
    const spec = POLICY_VALUES[name];
    if (value !== null && !(value >= spec.min && value <= spec.max)) {
      const said = `${spec.label} is from ${spec.min} to ${spec.max} ${spec.unit}, not ${value}`;
      if (options.lenient) notes.push(`A home's value "${name}" is left out: ${said}`);
      else problems.push({ message: said, path: ['homes', homeKey, 'policy', name], line: null, column: null });
      return false;
    }
    return true;
  };
  const policy = Object.entries(document.homes).flatMap(([key, entry]) => {
    homeKey = key;
    const existing = deps.places.homeByKey(key);
    const now: PolicyValues = existing ? deps.policyOf(existing.id).values() : {};
    return Object.entries(entry.policy)
      .filter(fits)
      .filter(([name, value]) => now[name as PolicyValueName] !== value)
      .map(([name, value]) => ({ home: key, name, label: POLICY_VALUES[name as PolicyValueName].label, before: now[name as PolicyValueName] ?? null, after: value }));
  });

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
    const goneScripts = deps.scripts.store.list().filter((script) => !document.scripts[script.key]);
    for (const script of goneScripts) scripts.push({ key: script.key, name: script.name, action: 'remove', changes: [] });
    if (goneScripts.length) needs.confirm.push(`${goneScripts.length === 1 ? `The script "${goneScripts[0]!.name}" is` : `${goneScripts.length} scripts are`} removed`);
  }

  // Placed in the text: what the plan found, at its line where it has one.
  const placed = problems.map((each) => {
    const at = read.problems.length ? null : locate(text, each.path);
    return { ...each, line: at?.line ?? null, column: at?.column ?? null };
  });
  const id = placed.length ? null : newId('plan');
  const view: ImportPlan = { id, from: read.from, problems: placed, devices, links, automations, family, people, homes, labels, scripts, zones, modes, policy, needs, notes };
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
    const description = brought ? deps.types.loaded(brought.type)?.describe(brought.settings as never) : here?.description;
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
    if (isAutomationRole(spec) || isScriptRole(spec) || isWorldRole(spec) || !use || 'automation' in use || 'script' in use || isWorldUse(use)) continue;
    const uses = 'parts' in use ? use.parts : [use];
    const parts = uses.flatMap((each, index) => {
      const part = partOf(spec, each, 'parts' in use ? ['uses', role, index] : ['uses', role]);
      return part ? [part] : [];
    });
    if (parts.length) bound.set(role, parts);
  }
  // What the filled parts must report and let be written: once the rule itself holds.
  if (checkRule(entry.rule, ruleVocabularyOf(deps, document)).length) return found;
  const filled = Object.fromEntries(Object.entries(entry.rule.roles).filter(([role, spec]) => !isAutomationRole(spec) && !isWorldRole(spec) && bound.has(role)));
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
      const type = deps.types.loaded(entry.type);
      return type ? [{ key, name: entry.name, description: type.describe(entry.settings as never) }] : [];
    });
  return [...yours, ...added].flatMap((device) =>
    partsOf(device.description)
      .filter((part) => !need || meetsNeed(need, capabilitiesOf(device.description, part.id)))
      .map((part) => ({ use: useText({ device: device.key, part: part.id }), name: part.id === MAIN_PART ? device.name : `${device.name} — ${part.label}` }))
  );
}

/** How a device would change: each difference in words, or "same". */
function deviceChanges(deps: ImportDeps, existing: DeviceRecord, entry: DeviceEntry, secrets: Map<string, string>, key: string, personId: (key: string) => string | null): Pick<ImportItem, 'action' | 'changes'> {
  const changes: string[] = [];
  if (entry.people && !samePeople(deps.devicePeople.of(existing.id), entry.people, personId)) changes.push('who it is with');
  if (existing.name !== entry.name) changes.push(`name: ${existing.name} → ${entry.name}`);
  if (entry.identity !== null && existing.identity !== entry.identity) changes.push('who it is: its identity');
  if (entry.picture !== existing.picture && entry.picture !== null) changes.push('its picture');
  if (entry.paused !== (existing.pausedAt !== null)) changes.push(entry.paused ? 'paused' : 'resumed');
  if (entry.track !== existing.trackDays) changes.push(entry.track === null ? 'where it has been: no longer kept, and forgotten' : `where it has been: kept ${entry.track === 1 ? '1 day' : `${entry.track} days`}`);
  if (labelsDiffer(deps, { device: existing.id }, entry.labels)) changes.push(`its labels: ${entry.labels.join(', ')}`);
  if (entry.place && !samePlace(placeOf(deps, existing.id), entry.place)) changes.push(`where it ${entry.place.role === 'based' ? 'is based' : 'stands'}: ${[entry.place.opening, entry.place.space, entry.place.home].filter(Boolean).join(', ')}`);
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
function automationChanges(deps: ImportDeps, document: ConfigDocument, existing: AutomationRecord, entry: AutomationEntry): Pick<ImportItem, 'action' | 'changes'> {
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
    if ('parts' in use) {
      const had = (existing.groups[role] ?? []).map((binding) => useText({ device: keyOf(binding.device), part: binding.part }));
      const said = use.parts.map((each) => useText(each));
      if (had.join() !== said.join()) changes.push(`${role}: ${said.join(', ') || 'no parts'}`);
    }
    if (isWorldUse(use)) {
      const now = worldFillOf(deps, document, entry, use);
      const had = existing.world[role];
      if (!now || !had || !sameFill(now, had)) changes.push(`${role}: who or where it is`);
    }
  }
  if (existing.ownTimeZone !== entry.clock) changes.push(entry.clock === null ? `clock: its home's, not ${existing.ownTimeZone}` : `clock: ${existing.ownTimeZone ?? "its home's"} → ${entry.clock}`);
  const homeKey = existing.homeId ? (deps.places.home(existing.homeId)?.key ?? null) : null;
  if (homeKey !== entry.home) changes.push(entry.home === null ? "for the family's homes, not one" : `for ${entry.home}`);
  if (existing.recheckMinutes !== entry.recheckMinutes) changes.push('how often it keeps things so');
  if (labelsDiffer(deps, { automation: existing.id }, entry.labels)) changes.push(`its labels: ${entry.labels.join(', ')}`);
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
export function keptPlan(deps: Pick<ImportDeps, 'pending'>, id: string, by: Actor): ImportPlan | null {
  const kept = deps.pending.get(id);
  return kept && sameActor(kept.by, by) && kept.expiresAt > Date.now() ? kept.view : null;
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
export function writeImport(deps: ImportDeps, id: string, by: Actor, choices: ImportChoices, options: { lenient?: boolean } = {}): Written {
  const kept = deps.pending.get(id);
  if (!kept || !sameActor(kept.by, by) || kept.expiresAt < Date.now()) throw new ApiError('not-found', 'That plan has gone: read the file again');
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

  const applied: ImportApplied = { devices: { added: [], restored: [], changed: [], removed: [] }, automations: { added: [], changed: [], removed: [] }, links: { added: 0, removed: 0 }, family: false, people: { added: [], changed: [] }, homes: { added: [], changed: [] }, labels: { added: [], changed: [] }, scripts: { added: [], changed: [], removed: [] }, zones: { added: [], changed: [] }, modes: { added: [], changed: [] }, policy: [], notes: [] };
  const touched: AutomationId[] = [];
  /** Where each automation goes on the home page: placed after all are written, by place, so each lands where the file says. */
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
      // People: who is in the family, before anything names them — admins first, so the family always has one.
      const order = { admin: 0, member: 1, child: 2 } as const;
      for (const item of [...view.people].sort((a, b) => order[document.people[a.key]!.role] - order[document.people[b.key]!.role])) {
        if (item.action === 'same') continue;
        each(`${document.people[item.key]!.name}`, () => {
        const entry = document.people[item.key]!;
        const chain = chainOf(entry.chain)!;
        if (chain.length > deps.people.chainOf(entry.id).length) deps.people.present(chain);
        const member = deps.people.get(entry.id)?.member;
        if (!member) deps.people.addMember(entry.id, { role: entry.role, invitedBy: null, at: new Date().toISOString() });
        const colourFree = entry.color !== null && !deps.people.members().some((each) => each.id !== entry.id && each.member?.color === entry.color);
        deps.people.updateMember(entry.id, { role: entry.role, ...(entry.nickname !== null ? { nickname: entry.nickname } : {}), ...(colourFree ? { color: entry.color! } : {}) });
        // What they share, as the file says — set by them, as they once chose it.
        const sharing = deps.people.get(entry.id)?.member?.sharing;
        if (entry.sharing && sharing && (entry.sharing.level !== sharing.level || entry.sharing.keepDays !== sharing.keepDays)) deps.people.setSharing(entry.id, { level: entry.sharing.level, keepDays: entry.sharing.keepDays }, entry.id, new Date().toISOString());
        (member ? applied.people.changed : applied.people.added).push(item.key);
        });
      }
      // Labels: before what is labelled with them.
      for (const item of view.labels) {
        if (item.action === 'same') continue;
        const entry = document.labels[item.key]!;
        const existing = deps.labels.byKey(item.key);
        const given = { name: entry.name, ...(entry.color !== null ? { color: entry.color } : {}), ...(entry.icon !== null ? { icon: entry.icon } : {}) };
        each(`The label "${entry.name}"`, () => {
          if (existing) (deps.labels.update(existing.id, given), applied.labels.changed.push(item.key));
          else (deps.labels.add({ ...given, key: item.key }), applied.labels.added.push(item.key));
        });
      }
      // Scripts: before the automations that will use them.
      for (const item of view.scripts) {
        if (item.action === 'same') continue;
        const existing = deps.scripts.store.byKey(item.key);
        if (item.action === 'remove') {
          if (existing && deps.scripts.store.remove(existing.id)) (deps.scripts.forget(existing.id), applied.scripts.removed.push(item.key));
          continue;
        }
        const entry = document.scripts[item.key]!;
        each(`The script "${entry.name}"`, () => {
          if (existing) (deps.scripts.store.update(existing.id, { name: entry.name, source: entry.source }, by, new Date().toISOString()), applied.scripts.changed.push(item.key));
          else (deps.scripts.store.add({ key: item.key, name: entry.name, source: entry.source }, by, new Date().toISOString()), applied.scripts.added.push(item.key));
        });
      }
      // The family, and its homes: first, since automations are for them.
      if (view.family.length) {
        deps.family.update({ ...(document.family.name !== null ? { name: document.family.name } : {}), ...(document.family.kind !== null ? { kind: document.family.kind } : {}), ...(document.family.locale !== null ? { locale: document.family.locale } : {}) });
        applied.family = true;
      }
      for (const item of view.homes) {
        if (item.action === 'same') continue;
        const entry = document.homes[item.key]!;
        const existing = deps.places.homeByKey(item.key);
        const location = entry.location ? { latitude: entry.location.latitude, longitude: entry.location.longitude, radius: entry.location.radius ?? existing?.location?.radius ?? HOME_RADIUS } : undefined;
        const address = existing ? Object.fromEntries(Object.entries(entry.address).map(([part, value]) => [part, value ?? existing.address[part as keyof typeof entry.address]])) : entry.address;
        // A picture is set only when it is kept here: one the file names but did not bring is said, and left.
        const picture = entry.picture !== null && deps.media.get(entry.picture) ? { pictureId: entry.picture } : {};
        if (entry.picture !== null && !('pictureId' in picture)) applied.notes.push(`${entry.name}'s picture did not come with the file: add it again on its page`);
        const given = { name: entry.name, type: entry.type, timeZone: entry.timeZone, bearing: entry.bearing, address: address as typeof entry.address, ...picture, ...(location ? { location } : {}), ...(entry.country !== null ? { country: entry.country } : {}), ...(entry.icon !== null ? { icon: entry.icon } : {}) };
        each(`The home "${entry.name}"`, () => {
          if (existing) (deps.places.updateHome(existing.id, given), applied.homes.changed.push(item.key));
          else (deps.places.addHome({ ...given, key: item.key }), applied.homes.added.push(item.key));
        });
        const home = deps.places.homeByKey(item.key);
        // Its spaces on their own: one that will not go does not take the home with it.
        if (home) each(`${entry.name}'s spaces`, () => writeSpaces(deps, home.id, entry, applied.notes));
        if (home) each(`${entry.name}'s variables`, () => writeVariables(deps, home.id, entry, new Date().toISOString()));
      }
      for (const item of view.zones) {
        if (item.action === 'same') continue;
        const entry = document.zones[item.key]!;
        const existing = deps.places.zoneByKey(item.key);
        const given = { name: entry.name, location: { latitude: entry.location.latitude, longitude: entry.location.longitude, radius: entry.location.radius ?? existing?.location.radius ?? ZONE_RADIUS }, ...(entry.icon !== null ? { icon: entry.icon } : {}) };
        each(`The zone "${entry.name}"`, () => {
          if (existing) (deps.places.updateZone(existing.id, given), applied.zones.changed.push(item.key));
          else (deps.places.addZone({ ...given, key: item.key }), applied.zones.added.push(item.key));
        });
      }
      // The family's own modes: before the automations that set them.
      for (const item of view.modes) {
        if (item.action === 'same') continue;
        const entry = document.modes[item.key]!;
        const existing = deps.modes.byKey(item.key);
        each(`The mode "${entry.name}"`, () => {
          if (existing) (deps.modes.update(existing.id, { name: entry.name, ...(entry.icon !== null ? { icon: entry.icon } : {}) }), applied.modes.changed.push(item.key));
          else (deps.modes.add({ key: item.key, axis: entry.axis, name: entry.name, icon: entry.icon }), applied.modes.added.push(item.key));
        });
      }
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
          writeDevice(deps, item.key, entry, kept.secrets, choices.secrets ?? {}, kept.by, (personKey) => document.people[personKey]?.id ?? null);
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
        const homeId = entry.home ? (deps.places.homeByKey(entry.home)?.id ?? null) : null;
        const id = existing?.id ?? deps.automations.create({ key: item.key, name: entry.name, rule: entry.rule, madeFrom: entry.madeFrom, roles: {}, groups: {}, starts: {}, homeId, timeZone: entry.clock, recheckMinutes: entry.recheckMinutes }).id;
        written.push({ key: item.key, entry, id, existing });
      }
      for (const { key, entry, id, existing } of written) {
        const roles: Record<string, { device: SavedDeviceId; part: string }> = {};
        const groups: Record<string, { device: SavedDeviceId; part: string }[]> = {};
        const starts: Record<string, AutomationId> = {};
        const scripts: Record<string, string> = {};
        const world: Record<string, WorldFill> = {};
        for (const [role, use] of Object.entries(entry.uses)) {
          if ('automation' in use) {
            const other = deps.automations.byKey(use.automation);
            if (other) starts[role] = other.id;
            continue;
          }
          // A script: the family's, written before the automations that run it.
          if ('script' in use) {
            const script = deps.scripts.store.byKey(use.script);
            if (script) scripts[role] = script.id;
            continue;
          }
          // A person, people, a place: by their ids here, now that the file's are written.
          if (isWorldUse(use)) {
            const fill = worldFillOf(deps, document, entry, use);
            if (fill) world[role] = fill;
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
        const result = deps.checked({ rule: entry.rule, roles, groups, starts, scripts, world }, id);
        // Restoring, one that cannot be kept as it was is kept turned off — its rule, what still fills it — and said: its owner's work is not lost.
        const why = [...new Set([...(kept.turnedOff.get(key) ?? []), ...result.problems])];
        if (why.length && !options.lenient) throw new ApiError('invalid', `"${entry.name}" cannot be kept as it is`, { problems: why.map((said) => `"${entry.name}": ${said}`) });
        each(`"${entry.name}"`, () => {
          const homeId = entry.home ? (deps.places.homeByKey(entry.home)?.id ?? null) : null;
          // Who it acts for: the person the file names, when they are here — else whoever imports it, saying yes by doing so.
          const named = entry.actsFor ? (personIdOf(deps, document, entry.actsFor) ?? null) : null;
          const actingFor = named ?? (by.kind === 'person' && by.id && deps.people.get(by.id) ? by.id : null);
          deps.automations.update(id, { name: entry.name, rule: entry.rule, roles: result.roles, groups: result.groups, starts: result.starts, scripts: result.scripts, world: result.world, homeId, timeZone: entry.clock, mode: why.length ? 'off' : entry.mode, actingFor, recheckMinutes: entry.recheckMinutes });
          writeLabels(deps, { automation: id }, entry.labels);
          (existing ? applied.automations.changed : applied.automations.added).push(key);
          if (why.length) applied.notes.push(`"${entry.name}" is restored turned off: ${why.join('; ')}`);
          touched.push(id);
        });
      }

      // Each person's own shortcuts, once their automations are: as the file has them, those it names that are here.
      for (const item of view.people) {
        const entry = document.people[item.key]!;
        if (!deps.people.get(entry.id)) continue;
        deps.shortcuts.set(entry.id, entry.shortcuts.flatMap((key) => deps.automations.byKey(key)?.id ?? []));
      }

      // Each home's values.
      for (const change of view.policy) {
        const home = deps.places.homeByKey(change.home);
        if (!home) continue;
        deps.policyOf(home.id).set(change.name as PolicyValueName, change.after);
        applied.policy.push(`${change.home}.${change.name}`);
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

/** A home's spaces in the order a file has them: each with its parent's key — none for the site — and its place among its siblings. */
function flatSpaces(spaces: readonly SpaceEntry[], parent: string | null = null): { space: SpaceEntry; parent: string | null; position: number }[] {
  return spaces.flatMap((space, position) => [{ space, parent, position }, ...flatSpaces(space.spaces, space.key)]);
}

/** How a home's spaces and openings would change, by key, in words. What the file does not have is left as it is. */
function spaceChanges(deps: ImportDeps, homeId: string | null, entry: HomeEntry): string[] {
  const keyOf = (id: string | null) => (id ? (deps.spaces.space(id)?.kind === 'site' ? SITE_KEY : (deps.spaces.space(id)?.key ?? null)) : null);
  // Where each stands among its siblings here: its order, not the numbers it is kept by — gaps an archive left are no change.
  const here = homeId ? deps.spaces.spaces(homeId) : [];
  const orderOf = (spaceId: string, parentId: string | null) =>
    here
      .filter((each) => each.parentId === parentId)
      .sort((a, b) => a.position - b.position)
      .findIndex((each) => each.id === spaceId);
  const [added, changed, opened, reopened] = [[], [], [], []] as string[][];
  for (const { space, parent, position } of flatSpaces(entry.spaces)) {
    const had = homeId ? deps.spaces.spaceByKey(homeId, space.key) : null;
    if (!had) added!.push(space.name);
    else if (
      had.name !== space.name ||
      had.kind !== space.kind ||
      had.purpose !== space.purpose ||
      had.level !== space.level ||
      had.elevation !== space.elevation ||
      had.height !== space.height ||
      had.icon !== space.icon ||
      orderOf(had.id, had.parentId) !== position ||
      keyOf(had.parentId) !== (parent ?? SITE_KEY) ||
      JSON.stringify(had.frame) !== JSON.stringify(space.frame) ||
      JSON.stringify(had.outline) !== JSON.stringify(space.outline) ||
      JSON.stringify(had.plan ? { picture: had.plan.pictureId, scale: had.plan.scale, x: had.plan.x, y: had.plan.y, turn: had.plan.turn } : null) !== JSON.stringify(space.plan) ||
      labelsDiffer(deps, { space: had.id }, space.labels)
    )
      changed!.push(space.name);
  }
  for (const [key, opening] of Object.entries(entry.openings)) {
    const had = homeId ? deps.spaces.openingByKey(homeId, key) : null;
    if (!had) opened!.push(opening.name ?? key);
    else if (had.kind !== opening.kind || had.name !== opening.name || keyOf(had.fromId) !== opening.from || keyOf(had.toId) !== opening.to || JSON.stringify(had.shape) !== JSON.stringify(opening.shape)) reopened!.push(opening.name ?? key);
  }
  const said = (what: string, names: string[]) => (names.length ? [`${what}: ${names.join(', ')}`] : []);
  // Its variables: what each is. What each holds now is the home's, and stays.
  const [declared, redeclared] = [[], []] as string[][];
  for (const [key, variable] of Object.entries(entry.variables)) {
    const had = homeId ? deps.variables.byKey(homeId, key) : null;
    if (!had) declared!.push(variable.field.title);
    else if (had.kind !== variable.kind || JSON.stringify(had.field) !== JSON.stringify(variable.field)) redeclared!.push(variable.field.title);
  }
  return [...said('spaces added', added!), ...said('spaces changed', changed!), ...said('openings added', opened!), ...said('openings changed', reopened!), ...said('variables added', declared!), ...said('variables changed', redeclared!)];
}

/**
 * A home's variables written as its entry has them, by key: added, or
 * changed — a value that no longer fits going back to what it starts as.
 * What the file does not have is left as it is.
 */
function writeVariables(deps: ImportDeps, homeId: string, entry: HomeEntry, at: string): void {
  for (const [key, variable] of Object.entries(entry.variables)) {
    const had = deps.variables.byKey(homeId, key);
    if (!had) {
      deps.variables.add(homeId, { key, kind: variable.kind, field: variable.field }, at);
      continue;
    }
    if (had.kind === variable.kind && JSON.stringify(had.field) === JSON.stringify(variable.field)) continue;
    deps.variables.update(had.id, { kind: variable.kind, field: variable.field });
    const kept = deps.variables.value(had.id);
    if (kept && !checkValue(valueTypeOf(variable.field), kept.value).ok) deps.variables.clear(had.id);
  }
}

/** A home's spaces and openings written as its entry has them, by key: parents before what is inside them. */
function writeSpaces(deps: ImportDeps, homeId: string, entry: HomeEntry, notes: string[] = []): void {
  const site = deps.spaces.site(homeId);
  for (const { space } of flatSpaces(entry.spaces)) if (space.plan && !deps.media.get(space.plan.picture)) notes.push(`${space.name}'s drawing did not come with the file: add it again on the home's map`);
  for (const { space, parent, position } of flatSpaces(entry.spaces)) {
    const parentId = parent === null ? site.id : deps.spaces.spaceByKey(homeId, parent)!.id;
    // A drawing is set only when its picture is kept here: one the file names but did not bring is left as it is.
    const plan = space.plan && deps.media.get(space.plan.picture) ? { plan: { pictureId: space.plan.picture, scale: space.plan.scale, x: space.plan.x, y: space.plan.y, turn: space.plan.turn } } : space.plan ? {} : { plan: null };
    const given = { parentId, kind: space.kind, name: space.name, purpose: space.purpose, icon: space.icon, level: space.level, elevation: space.elevation, height: space.height, frame: space.frame, outline: space.outline, ...plan, position };
    const had = deps.spaces.spaceByKey(homeId, space.key);
    const written = had ? deps.spaces.updateSpace(had.id, given)! : deps.spaces.addSpace({ ...given, key: space.key });
    writeLabels(deps, { space: written.id }, space.labels);
  }
  /** A space by its key — `site`, the home itself. */
  const spaceOf = (key: string) => (key === SITE_KEY ? site : deps.spaces.spaceByKey(homeId, key));
  for (const [key, opening] of Object.entries(entry.openings)) {
    const from = spaceOf(opening.from);
    const to = opening.to === null ? null : spaceOf(opening.to);
    if (!from || (opening.to !== null && !to)) continue;
    const given = { fromId: from.id, toId: to?.id ?? null, kind: opening.kind, name: opening.name, shape: opening.shape };
    const had = deps.spaces.openingByKey(homeId, key);
    if (had) deps.spaces.updateOpening(had.id, given);
    else deps.spaces.addOpening({ ...given, key });
  }
}

/** A person's chain as a file carries it — base64url of its JSON — or null for anything that is not one. */
function chainOf(text: string): Statement[] | null {
  const bytes = fromBase64url(text);
  if (!bytes) return null;
  try {
    const chain = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    return Array.isArray(chain) ? (chain as Statement[]) : null;
  } catch {
    return null;
  }
}

/** A person's id by their key: in the file, or here by the key the family's file would give them. */
function personIdOf(deps: ImportDeps, document: ConfigDocument, key: string): string | null {
  const inFile = document.people[key]?.id;
  if (inFile && deps.people.get(inFile)?.member) return inFile;
  return deps.people.members().find((person) => person.fileKey === key || person.id === key)?.id ?? null;
}

/** Whether a file says other labels than a thing has: by key. None said leaves them as they are. */
function labelsDiffer(deps: ImportDeps, target: LabelTarget, said: readonly string[]): boolean {
  if (!said.length) return false;
  return deps.labels.on(target).map((label) => label.key).sort().join() !== [...new Set(said)].sort().join();
}

/** A thing's labels as a file says them, those that are here: none said leaves them as they are. */
function writeLabels(deps: ImportDeps, target: LabelTarget, said: readonly string[]): void {
  if (!labelsDiffer(deps, target, said)) return;
  deps.labels.set(target, said.flatMap((key) => deps.labels.byKey(key)?.id ?? []));
}

/** What a rule in a file is checked against, as applying it will be: the installed functions, and the family's modes — here, and those the file brings. */
const ruleVocabularyOf = (deps: ImportDeps, document: ConfigDocument): RuleVocabulary => ({
  fn: (id) => deps.library.fn(id),
  modes: () => [...deps.modes.list().map((mode) => ({ key: mode.key, axis: mode.axis, name: mode.name })), ...Object.entries(document.modes).map(([key, mode]) => ({ key, axis: mode.axis, name: mode.name }))],
});

/** Whether what fills a role is the family's world: a person, people, a place. */
const isWorldUse = (use: Use): use is WorldUse => 'person' in use || 'people' in use || 'everyone' in use || 'home' in use || 'zone' in use || 'space' in use;

/** Each member's key, as an export writes them: what a file without its people names them by. */
/**
 * Each member by the name a file gives them: their key — or, one with no key
 * of their own yet, their id. Read once for everything a plan or an apply
 * asks in one turn, not once a name; a file's own people are its own.
 */
const keysRead = new WeakMap<object, Map<string, string>>();
const familyKeys = (deps: ImportDeps): Map<string, string> => {
  const had = keysRead.get(deps.people);
  if (had) return had;
  const keys = new Map(deps.people.members().flatMap((person) => [[person.fileKey ?? person.id, person.id] as const, [person.id, person.id] as const]));
  keysRead.set(deps.people, keys);
  queueMicrotask(() => keysRead.delete(deps.people));
  return keys;
};

/** The home an automation's spaces are of: the one it is for, or the family's first — in the file, or here. */
const homeKeyOf = (deps: ImportDeps, document: ConfigDocument, entry: AutomationEntry): string | null => entry.home ?? Object.keys(document.homes)[0] ?? deps.places.homes()[0]?.key ?? null;

/** What a person, people or a place a file names is here — or will be, once the file is applied — said by what is not. */
function worldMissing(deps: ImportDeps, document: ConfigDocument, entry: AutomationEntry, use: WorldUse): string[] {
  if ('everyone' in use) return [];
  if ('person' in use || 'people' in use) {
    const known = familyKeys(deps);
    return ('person' in use ? [use.person] : use.people).filter((key) => !document.people[key] && !known.has(key)).map((key) => `there is no person "${key}", in the file or in the family`);
  }
  if ('home' in use) return document.homes[use.home] || deps.places.homeByKey(use.home) ? [] : [`there is no home "${use.home}"`];
  if ('zone' in use) return document.zones[use.zone] || deps.places.zoneByKey(use.zone) ? [] : [`there is no zone "${use.zone}"`];
  const homeKey = homeKeyOf(deps, document, entry);
  const brought = homeKey ? document.homes[homeKey] : undefined;
  const here = homeKey ? deps.places.homeByKey(homeKey) : null;
  const found = (brought && flatSpaces(brought.spaces).some((each) => each.space.key === use.space)) || (here && deps.spaces.spaceByKey(here.id, use.space));
  return found ? [] : [`there is no space "${use.space}" in ${brought?.name ?? here?.name ?? 'its home'}`];
}

/** What a person, people or a place a file names is, by id here: none when it is not here. */
function worldFillOf(deps: ImportDeps, document: ConfigDocument, entry: AutomationEntry, use: WorldUse): WorldFill | null {
  if ('everyone' in use) return { everyone: true };
  if ('person' in use || 'people' in use) {
    const known = familyKeys(deps);
    const ids = ('person' in use ? [use.person] : use.people).flatMap((key) => document.people[key]?.id ?? known.get(key) ?? []);
    if ('person' in use) return ids[0] ? { person: ids[0] } : null;
    return { people: ids };
  }
  if ('home' in use) {
    const home = deps.places.homeByKey(use.home);
    return home ? { place: home.id, kind: 'home' } : null;
  }
  if ('zone' in use) {
    const zone = deps.places.zoneByKey(use.zone);
    return zone ? { place: zone.id, kind: 'zone' } : null;
  }
  const homeKey = homeKeyOf(deps, document, entry);
  const home = homeKey ? deps.places.homeByKey(homeKey) : null;
  const space = home ? deps.spaces.spaceByKey(home.id, use.space) : null;
  return space ? { place: space.id, kind: 'space' } : null;
}

/** Whether a device stands where a file says: by keys. */
function samePlace(now: PlaceEntry | null, said: PlaceEntry): boolean {
  return (
    now !== null &&
    now.home === said.home &&
    now.space === said.space &&
    now.opening === said.opening &&
    now.role === said.role &&
    JSON.stringify(now.at) === JSON.stringify(said.at) &&
    now.height === said.height &&
    now.facing === said.facing
  );
}

/** Why where a file says a device stands is nowhere — no home, space or opening by those keys, in the file or here — or null. */
function placeProblem(deps: ImportDeps, document: ConfigDocument, place: PlaceEntry): string | null {
  const brought = document.homes[place.home];
  const here = deps.places.homeByKey(place.home);
  if (!brought && !here) return `There is no home "${place.home}", in the file or here`;
  if (place.space !== null && !(brought && flatSpaces(brought.spaces).some((each) => each.space.key === place.space)) && !(here && deps.spaces.spaceByKey(here.id, place.space)))
    return `${brought?.name ?? here!.name} has no space "${place.space}"`;
  if (place.opening !== null && !brought?.openings[place.opening] && !(here && deps.spaces.openingByKey(here.id, place.opening))) return `${brought?.name ?? here!.name} has no opening "${place.opening}"`;
  // At an opening of the space it stands in: a door is in a wall of its room.
  if (place.opening !== null) {
    const said = brought?.openings[place.opening];
    const kept = here ? deps.spaces.openingByKey(here.id, place.opening) : null;
    const ends = said ? [said.from, said.to] : kept ? [kept.fromId, kept.toId].map((id) => (id ? (deps.spaces.space(id)?.kind === 'site' ? SITE_KEY : (deps.spaces.space(id)?.key ?? null)) : null)) : [];
    if (!ends.includes(place.space ?? SITE_KEY)) return `The opening "${place.opening}" is not one of ${place.space ?? 'the home itself'}`;
  }
  return standingProblem({ x: place.at?.[0] ?? null, y: place.at?.[1] ?? null, z: place.height, facing: place.facing });
}

/** Where a file says a device stands, as a placement here: null when its home, space or opening is not here. */
function spotOf(deps: ImportDeps, place: PlaceEntry): PlacementInput | null {
  const home = deps.places.homeByKey(place.home);
  if (!home) return null;
  const space = place.space === null ? deps.spaces.site(home.id) : deps.spaces.spaceByKey(home.id, place.space);
  const opening = place.opening === null ? null : deps.spaces.openingByKey(home.id, place.opening);
  if (!space || (place.opening !== null && !opening)) return null;
  return { spaceId: space.id, openingId: opening?.id ?? null, role: place.role, x: place.at?.[0] ?? null, y: place.at?.[1] ?? null, z: place.height, facing: place.facing === null ? null : turnOf(place.facing) };
}

/** A device added or changed as its entry says: what it is, how it is reached, its secrets, kept or given. */
/** Who a device is with, as kept here and as a file says it: the same people in each role. */
function samePeople(kept: DevicePeople, said: DevicePeopleEntry, personId: (key: string) => string | null): boolean {
  const ids = (keys: readonly string[]) => keys.flatMap((key) => personId(key) ?? []).sort().join();
  return (
    ids(said.carries ? [said.carries] : []) === (kept.carries ?? '') &&
    ids(said.drives ? [said.drives] : []) === (kept.drives ?? '') &&
    ids(said.owns) === [...kept.owns].sort().join() &&
    ids(said.uses) === [...kept.uses].sort().join()
  );
}

function writeDevice(deps: ImportDeps, key: string, entry: DeviceEntry, opened: Map<string, string>, given: Record<string, string>, by: Actor, personId: (key: string) => string | null): void {
  // Loaded when its plan was made: what it is, with its settings, is its code's to say.
  const type = deps.types.loaded(entry.type)!;
  const settings = validateConfig(type.config ?? { fields: {} }, entry.settings);
  if (!settings.ok) throw new ApiError('invalid', `${entry.name}: ${settings.issues.map((issue) => issue.message).join('; ')}`);
  const config: ConfigValues = settings.value;
  let device = deps.catalog.byKey(key);
  // One you removed is brought back with its history, not added beside it.
  const back = device ? null : removedMatch(deps, key, entry);
  if (back) device = deps.catalog.update(deps.catalog.restore(back.id)!.id, { key, name: entry.name, config, ...(entry.identity !== null ? { identity: entry.identity } : {}) })!;
  else if (!device) device = deps.catalog.add({ typeId: entry.type, name: entry.name, identity: entry.identity, config, description: type.describe(config as never), key });
  else device = deps.catalog.update(device.id, { name: entry.name, config, ...(entry.identity !== null ? { identity: entry.identity } : {}) })!;
  // A photo of its own is set only when it is kept here; one the file did not bring is left as it is.
  const kept = entry.picture === null || !entry.picture.startsWith('own:') || deps.media.get(entry.picture.slice(4)) !== null;
  if (entry.picture !== null && entry.picture !== device.picture && kept) deps.catalog.setPicture(device.id, entry.picture);
  if (entry.paused !== (device.pausedAt !== null)) deps.catalog.setPaused(device.id, entry.paused);
  if (entry.track !== device.trackDays) deps.catalog.setTrack(device.id, entry.track);
  // Where it stands, where the file says so and it is somewhere here: what it does not say leaves it where it is.
  const spot = entry.place && !samePlace(placeOf(deps, device.id), entry.place) ? spotOf(deps, entry.place) : null;
  if (spot) deps.spaces.place(device.id, spot, by);
  writeLabels(deps, { device: device.id }, entry.labels);
  // Who it is with, where the file says so: each a person in the family, as the file's people were just written.
  if (entry.people && !samePeople(deps.devicePeople.of(device.id), entry.people, personId)) {
    const at = new Date().toISOString();
    const members = (keys: readonly string[]) => keys.flatMap((personKey) => personId(personKey) ?? []).filter((id) => deps.people.get(id)?.member);
    deps.devicePeople.set(device.id, 'carries', members(entry.people.carries ? [entry.people.carries] : []), at);
    deps.devicePeople.set(device.id, 'drives', members(entry.people.drives ? [entry.people.drives] : []), at);
    deps.devicePeople.set(device.id, 'owns', members(entry.people.owns), at);
    deps.devicePeople.set(device.id, 'uses', members(entry.people.uses), at);
  }

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
    if (Object.keys(secrets).length) {
      // What a person gave, and what its session keeps: a sign-in token, carried so a restore does not sign in again.
      const { person, session } = bySource(method, deps.protocols.get(method.protocol) ?? null, secrets);
      if (Object.keys(person).length) deps.connections.setSecrets(connection.id, person);
      if (Object.keys(session).length) deps.connections.setSecrets(connection.id, session, 'session');
    }
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

