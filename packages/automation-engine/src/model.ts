import type { AutomationRun } from '@kraftverk/api-contract';
import type { AutomationMode, Axis, Coordinates, NotifyLevel, PlaceKind, RoleBinding, Rule, RulePart, ScriptShape, WorldFill } from '@kraftverk/automation';
import type { AuditRecord, AutomationId, CapabilityId, Clock, DeviceDescription, Value } from '@kraftverk/device-sdk';
import type { ActionGateway, GatewayActor } from '@kraftverk/gateway';
import type { LiveBus } from '@kraftverk/holder';

import type { AutomationLibrary } from './library.ts';
import type { AutomationStorage } from './storage.ts';

/*
  What the engine's parts share: an automation as it keeps it, the part
  filling a role as it sees it, what the engine is made from, who may start
  a run, and how the gateway knows an automation's doing from a person's.
*/

export type { AutomationMode };

export type AutomationRecord = {
  id: AutomationId;
  /** Its name in configuration: what a file and an import know it by (docs/CONFIG.md). */
  key: string;
  name: string;
  /** Its own rule, as its owner built it — or copied it from a recipe (docs/AUTOMATION-EDITOR.md). */
  rule: Rule;
  /** The recipe it was copied from, to say so; null when built from nothing. */
  madeFrom: string | null;
  /** Which part of which device fills each role a part fills. */
  roles: Record<string, RoleBinding>;
  /** The parts filling each group a `for each` goes through, in order. */
  groups: Record<string, readonly RoleBinding[]>;
  /** Which automation fills each role a `start` step starts. */
  starts: Record<string, AutomationId>;
  /** Who and where fills each role of the family's world: a person, people, a place. */
  world: Record<string, WorldFill>;
  /** Which of the family's scripts fills each role a script fills, by its id. */
  scripts: Record<string, string>;
  /** The person whose yes it acts on (docs/PLAN-SCRIPTS.md §4.1): the one who last let it act. Null while it does not act. What its scripts do, they do for them. */
  actingFor: string | null;
  /** The home it is for: its clock, and what "home" is in its rule. Null: the family's, on its first home's clock. */
  homeId: string | null;
  /** Its clock: its own, or else its home's — "Europe/Stockholm". */
  timeZone: string;
  /** A clock of its own, when it keeps one; null when it keeps its home's. */
  ownTimeZone: string | null;
  mode: AutomationMode;
  /** Every this many minutes, a condition that still holds runs it again, unless what it would do is already so. Null: never. */
  recheckMinutes: number | null;
  /** When it last looked again to keep things so, or started afresh. */
  lookedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Its latest run that has ended. */
  lastRun: AutomationRun | null;
  /** The run it is taking now. */
  running: AutomationRun | null;
};

/** The part filling a role, as the engine sees it: enough to check the role, read it, and hand it to a function. */
export type EngineDevice = RulePart & {
  /** The device's own name, without its part's: "Garage station". */
  deviceName: string;
  /** Its type: "acme.station". */
  typeId: string;
  removed: boolean;
  /** Whether the device still has that part. */
  hasPart: boolean;
  description: DeviceDescription;
  /** What the part offers. */
  capabilities: readonly CapabilityId[];
  /** Whether it can be reached now: its holder says it is connected — and, when not, why. */
  reachable(): { reachable: boolean; detail: string };
  /** Someone waits on its readings until then: its holder asks it more often, as its type sees fit. */
  wantFresh(until: number): void;
};

/** A place as the engine names one: a home, a zone, or a space of a home, by its id. */
export type EnginePlace = { id: string; kind: PlaceKind };

/**
 * The family's world, as an automation sees it: who is where — as far as
 * each shares — whether a place has anyone in it, a home's modes; and what
 * an automation may do there besides its devices: set a mode, tell people.
 */
export type EngineWorld = {
  /** The home an automation is for — or, none said, the family's first. Null: the family has no home, or the one it is for was let go. */
  home(homeId: string | null): string | null;
  /** Everyone in the family now. */
  members(): readonly string[];
  /** A person as the family calls them; null for one it does not know. */
  personName(id: string): string | null;
  /** A place's name; null for one let go. */
  placeName(place: EnginePlace): string | null;
  /** The home a place is at: a home itself, a space's home; none for a zone. */
  homeOf(place: EnginePlace): string | null;
  /**
   * Who of the family is at a place now, as far as each shares — and who
   * might be, for all that can be told: someone who shares too little to
   * say is not away. Null: the place is not there.
   */
  whoAt(place: EnginePlace): { at: readonly string[]; unknown: readonly string[] } | null;
  /** Whether a place is, or is within, another: a room within a floor. Homes and zones are only themselves. */
  within(place: EnginePlace, outer: EnginePlace): boolean;
  /** Whether anyone is in a place now, whoever: a space by what stands there, a home or a zone by who is there. Null when it cannot be told. */
  occupied(place: EnginePlace): boolean | null;
  /** A home's mode on an axis now, by its key; null when none is set. */
  mode(homeId: string, axis: Axis): string | null;
  /** The family's modes: the built-in ones, and its own — each by key, on its axis. */
  modes(): readonly { key: string; axis: Axis; name: string }[];
  /**
   * A home set to a mode, by its key, as an automation: on its timeline, and
   * said on the bus with the automations whose runs led to it (`cause`,
   * outermost first, this one last).
   */
  setMode(homeId: string, mode: string, by: GatewayActor, cause: readonly string[]): void;
  /** People told something: each one's inbox, and a push sent on its way. Who was told: members only. */
  notify(people: readonly string[], message: { title: string; text: string | null; level: NotifyLevel; homeId: string | null }, by: GatewayActor): { told: readonly string[] };
};

/** What the home kept of each reading, minute by minute, by device and attribute key. */
export type EngineHistory = {
  /** What was kept between two times, oldest first. */
  samples(deviceId: string, key: string, fromIso: string, toIso: string): readonly { at: string; value: number | null }[];
  /** The last kept at or before a time: what the reading was then. */
  at(deviceId: string, key: string, iso: string): { at: string; value: number | null } | null;
};

export type AutomationEngineDeps = {
  store: AutomationStorage;
  library: Pick<AutomationLibrary, 'fn'>;
  device: (binding: RoleBinding) => EngineDevice | null;
  gateway: Pick<ActionGateway, 'execute' | 'write' | 'runEnded' | 'lastSwitch' | 'lastWrite'>;
  record: (entry: AuditRecord) => void;
  /** What devices say as they say it: events and readings start runs; and where a run in progress is said to have moved. */
  bus?: LiveBus;
  /** What the home kept of each reading: what a rule looks back at (`average(station.charge, 1 h)`). None: unknown. */
  history?: EngineHistory;
  /**
   * Where a home is, as it is now: what `sunrise` and `sunset` are told by,
   * and what "home" is in a rule. The home an automation is for, by its id;
   * null asks for the family's first. None, or null: unknown.
   */
  location?: (homeId: string | null) => Coordinates | null;
  /** The family's world: who is where, a room's occupancy, a home's modes — and setting a mode, telling people. None: unknown, and those steps fail. */
  world?: EngineWorld;
  /**
   * The home's time: what its triggers, holds, pauses and runs keep, and
   * what it stamps. Real time when not given; a test's own — fixed, or fast.
   */
  clock?: Clock;
  /** How often it looks at what is due by the clock, in the clock's time. */
  everyMs?: number;
  /** What runs its scripts' steps and functions (docs/PLAN-SCRIPTS.md §10): the hub's. None: a script step fails, and a function is not known. */
  scripts?: ScriptRunner;
};

/** One step of a script, as a run takes it: what the hub's runner is asked (docs/PLAN-SCRIPTS.md §10). */
export type ScriptStepRequest = {
  automation: AutomationRecord;
  /** The run: its id, who asked for it, and the automations whose doing led to it — what a mode it sets carries, so none loops. */
  run: { id: string; askedBy: Asker | null; cause: readonly string[] };
  scriptId: string;
  /** Which of its steps, when the automation says; else its only one. */
  step: string | undefined;
  /** What it is given, by its inputs' names, in their units. */
  inputs: Readonly<Record<string, Value>>;
  /** What it remembered for this automation, by its names. */
  memory: Readonly<Record<string, Value>>;
  /** When it must have ended, on the home's clock: a wait never outlives it. */
  deadline: number;
  /** Aborted when its run is stopped. */
  signal: AbortSignal;
  /** A line in the run's log, under the step: what it did and what came of it, or what it said. */
  /** A line beneath its step: what it did — or, `said`, what it said with `log`. */
  say(line: { what: string; outcome: 'done' | 'refused' | 'failed' | 'unverified' | 'would'; detail: string | null; said?: true }): void;
};

/** How a script's step came out: its answer and what it remembers now, or why it did not end well. */
export type ScriptStepDone = { answer: Value | null; memory: Record<string, Value> } | { fault: string };

/** The scripts of the family, as the engine runs them — the hub's to give. */
export type ScriptRunner = {
  step(request: ScriptStepRequest): Promise<ScriptStepDone>;
  /** One of a script's functions, its arguments known: at once, pure; a fault is unknown, with why. */
  fn(scriptId: string, fn: string, args: readonly Value[]): { value: Value | null; detail: string | null };
  /** What a script declares, where it reads: what a step or a call of it is checked against. */
  shape(scriptId: string): ScriptShape | null;
  /** Its name, as the run's words say it; null when it is gone. */
  name(scriptId: string): string | null;
};

/** An automation as the actor of what it does: known by its id, which a rename does not change, and said by its name. */
export const actorOf = (automation: Pick<AutomationRecord, 'id' | 'name'>): GatewayActor & { kind: 'automation' } => ({ kind: 'automation', id: automation.id, name: automation.name });

/** Why a run cannot be started or stopped, in words for the person who asked. */
export class RunRefusal extends Error {}

/**
 * Who asked for a run: a person, or an assistant for one — an actor, whose
 * name is how the run says it and whose kind is how the gateway treats its
 * first switches: a person's dwell, or an assistant's.
 */
export type Asker = GatewayActor & { kind: 'person' | 'agent' };
