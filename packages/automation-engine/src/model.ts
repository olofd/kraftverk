import type { AutomationRun } from '@kraftverk/api-contract';
import type { AutomationMode, RoleBinding, Rule, RulePart } from '@kraftverk/automation';
import type { AuditRecord, AutomationId, CapabilityId, Clock, DeviceDescription } from '@kraftverk/device-sdk';
import type { ActionGateway } from '@kraftverk/gateway';
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
  /** Which automation fills each role a `start` step starts. */
  starts: Record<string, AutomationId>;
  /** The owner's clock, from the app it was made in: "Europe/Stockholm". */
  timeZone: string;
  mode: AutomationMode;
  /** Every this many minutes, a condition that still holds runs it again, unless what it would do is already so. Null: never. */
  recheckMinutes: number | null;
  /** Its place among the shortcuts on the home page; null when it is not there. */
  homePlace: number | null;
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

export type AutomationEngineDeps = {
  store: AutomationStorage;
  library: Pick<AutomationLibrary, 'fn'>;
  device: (binding: RoleBinding) => EngineDevice | null;
  gateway: Pick<ActionGateway, 'execute' | 'write' | 'runEnded' | 'lastSwitch' | 'lastWrite'>;
  record: (entry: AuditRecord) => void;
  /** What devices say as they say it: events and readings start runs; and where a run in progress is said to have moved. */
  bus?: LiveBus;
  /**
   * The home's time: what its triggers, holds, pauses and runs keep, and
   * what it stamps. Real time when not given; a test's own — fixed, or fast.
   */
  clock?: Clock;
  /** How often it looks at what is due by the clock, in the clock's time. */
  everyMs?: number;
};

/** How the gateway's audit and memory name what an automation did: by its id, which a rename does not change. */
export const AUTOMATION_ACTOR = 'automation:';
export const actorOf = (automation: Pick<AutomationRecord, 'id'>): string => `${AUTOMATION_ACTOR}${automation.id}`;

/** Why a run cannot be started or stopped, in words for the person who asked. */
export class RunRefusal extends Error {}

/**
 * Who asked for a run: a person, or an assistant for one. `name` is how the
 * run says it ("olof", "assistant for olof"); `actor` is how the gateway
 * treats its first switches — a person's dwell, or an assistant's.
 */
export type Asker = { name: string; actor: 'person' | 'agent' };
