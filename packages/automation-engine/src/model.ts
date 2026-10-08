import type { AutomationRun } from '@kraftverk/api-contract';
import type { AutomationMode, Axis, Coordinates, NotifyLevel, PlaceKind, RoleBinding, Rule, RulePart, WorldFill } from '@kraftverk/automation';
import type { AuditRecord, AutomationId, CapabilityId, Clock, DeviceDescription } from '@kraftverk/device-sdk';
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
  /** The home an automation is for — or, none said, the family's first. Null: the family has no home. */
  home(homeId: string | null): string | null;
  /** Everyone in the family now. */
  members(): readonly string[];
  /** A person as the family calls them; null for one it does not know. */
  personName(id: string): string | null;
  /** A place's name; null for one let go. */
  placeName(place: EnginePlace): string | null;
  /** The home a place is at: a home itself, a space's home; none for a zone. */
  homeOf(place: EnginePlace): string | null;
  /** Who of the family is at a place now, as far as each shares; null when it cannot be told. */
  peopleAt(place: EnginePlace): readonly string[] | null;
  /** Whether anyone is in a place now, whoever: a space by what stands there, a home or a zone by who is there. Null when it cannot be told. */
  occupied(place: EnginePlace): boolean | null;
  /** A home's mode on an axis now, by its key; null when none is set. */
  mode(homeId: string, axis: Axis): string | null;
  /** The keys of the family's modes: the built-in ones, and its own. */
  modes(): readonly string[];
  /** A home set to a mode, by its key, as an automation: on its timeline, and said on the bus. */
  setMode(homeId: string, mode: string, by: GatewayActor): void;
  /** People told something: each one's inbox, and a push. */
  notify(people: readonly string[], message: { title: string; text: string | null; level: NotifyLevel; homeId: string | null }, by: GatewayActor): Promise<void>;
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
