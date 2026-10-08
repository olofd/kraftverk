import {
  type Actor,
  type AuditRecord,
  type PolicyValues,
  attributeMeaning,
  capabilitiesOf,
  capabilityIn,
  checkValue,
  conditionHolds,
  currentForOf,
  isScalar,
  linkKindSpec,
  MAIN_PART,
  REAL_CLOCK,
  sleep,
  type Clock,
  partsOf,
  partName,
  readingOf,
  standardMeaning,
  thresholdOf,
  type AttributeSpec,
  type CapabilityCommand,
  type CapabilityId,
  type DeviceDescription,
  type DeviceSession,
  type LinkEnd,
  type LinkKind,
  type LinkKindSpec,
  type Reading,
  type SavedDeviceId,
  type Value,
} from '@kraftverk/device-sdk';
import { Confirmations, subjectOf } from './confirmations.ts';

/**
 * The only path a command to hardware takes (docs/ARCHITECTURE.md §4.6).
 *
 * Every command — from a screen, an automation or a bridge — and every write
 * of a device's own settings comes here, and everything it has to survive
 * lives here: what makes a command consequential, read-only mode, dwell time,
 * the freshness of what the decision rests on, and — the part that makes it
 * more than a wrapper — verification. A device saying "done" is not proof.
 * Reading back what the command sets is one proof; and a command on a part
 * that is the source of a link is proven only by the target's own reading of
 * the link's evidence agreeing — a station seeing its mains go when the plug
 * that feeds it is switched off — from a reading it took after the command.
 *
 * It names no capability, no link kind and no domain: what a command takes,
 * what it sets and what makes it consequential come from the capability's
 * declaration; what a link proves, and whether being its source matters, from
 * the link kind's; and what a device reads, and how long each reading stays
 * current, from its description. A new capability or link kind needs no edit
 * here.
 */

export type CommandIntent = {
  deviceId: SavedDeviceId;
  /** The part it is for: `main`, `outlet.ac`. */
  part: string;
  capability: CapabilityId;
  command: string;
  args: Readonly<Record<string, Value>>;
  reason: string;
  /**
   * Who is asking. Its kind decides policy — a person confirms; an
   * automation has its own dwell time; an agent (an assistant acting for a
   * person) may do what needs no one's yes, and never gives that yes itself
   * — and is set by the code that made it, never read out of its name.
   */
  by: GatewayActor;
  /**
   * The token a refusal handed out, presented with the retry once a person
   * has said yes: required for a consequential command, and for the first
   * command through a link that makes its source consequential.
   */
  confirmation?: string;
  /**
   * A step of a run of an automation that takes steps (docs/SEQUENCES.md).
   * Within the run, a part it already switched may be switched again sooner
   * than the dwell — after the gateway's own least gap, and no more often than
   * the run says its rule may, nor than the gateway's own ceiling: what makes
   * sure a charger that stays idle is switched off and on again, a few times
   * at most. The run's first switch of a part meets the dwell as any command
   * does — that of whoever started the run. Its counts are let go when the
   * run ends (`runEnded`).
   */
  run?: {
    id: string;
    /** Who asked for it: a person, or an assistant for one; null, its own triggers started it. */
    askedBy: 'person' | 'agent' | null;
    /** How often its rule may switch this part within it, at most. */
    switches: number;
  };
};

/** Who may ask the gateway for anything: a person, an assistant for one, or an automation. */
export type GatewayActor = Actor & { readonly kind: 'person' | 'agent' | 'automation' };

export type GatewayOutcome =
  | 'verified' // it happened, and everything that can say so agrees
  | 'unverified' // accepted, but the physical effect is unproven
  | 'refused' // policy said no; nothing was sent
  | 'failed'; // the command itself errored

export type GatewayResult = {
  outcome: GatewayOutcome;
  detail: string;
  /** The device's own readback agrees. */
  deviceAgreed?: boolean;
  /** Every part it is linked to agrees — for a part that is a link's source. */
  linkAgreed?: boolean;
  /**
   * Refused only because a person has to confirm it: ask, and send it again
   * with `confirmation` set to this token, good for this intent and this
   * person, once, for a minute. The detail says why it matters.
   */
  needsConfirmation?: string;
  /** With `needsConfirmation`: why it matters, as the question a person is asked — the detail without its preamble. */
  reason?: string;
  /**
   * Refused only because the run switched this part a moment ago: the same
   * intent is taken once this many milliseconds have passed. A run waits it
   * out; a person is told.
   */
  retryInMs?: number;
  /**
   * Refused only because what it acts on was read too long ago — a reading
   * late over the network, a device asked too seldom: these parts. The same
   * intent is taken once each has said something new. A run asks them for
   * fresh readings and waits a moment; a person is told.
   */
  stale?: readonly { device: SavedDeviceId; part: string }[];
};

export type GatewayPolicy = {
  /**
   * The oldest a reading may be and still be acted on: acting asks more than
   * showing, so a reading must be current for its attribute *and* no older
   * than this.
   */
  maxDataAgeMs: number;
  /** Minimum gap between an automation's changes to one part. */
  automationDwellMs: number;
  /** A much shorter guard for a person tapping a button, so the acceptance drill is possible. */
  personDwellMs: number;
  /** An assistant acts at a person's request, but can repeat itself faster than one: a minute between its changes to one part. */
  agentDwellMs: number;
  /** Between two writes of one setting by a person: long enough for the first to settle, short enough not to be noticed. */
  userWriteDwellMs: number;
  /** How long a device is given to take a command or a write: one that never answers ends as failed, not as a line every other waits in. */
  sendTimeoutMs: number;
  /** How long the device and the parts it is linked to are given to agree. */
  verifyTimeoutMs: number;
  /** Within one run, the least gap between two switches of a part, whatever its rule asks. */
  runGapMs: number;
  /** Within one run, the most switches of one part, whatever its rule asks. */
  runSwitchCeiling: number;
};

export const DEFAULT_POLICY: GatewayPolicy = {
  maxDataAgeMs: 60_000,
  automationDwellMs: 10 * 60_000,
  personDwellMs: 5_000,
  agentDwellMs: 60_000,
  userWriteDwellMs: 2_000,
  sendTimeoutMs: 20_000,
  verifyTimeoutMs: 30_000,
  runGapMs: 3_000,
  runSwitchCeiling: 12,
};

/** When something was last switched or written, in milliseconds, and by whom: the intent's `by`. */
export type LedgerMark = { at: number; by: Actor };

/**
 * What the gateway remembers of each device: when each part was last
 * switched, and by whom — what its dwell counts from; a part never switched
 * has never been, and its first switch through a consequential link is
 * confirmed — and when each setting was last written, and by whom: one write
 * per setting per dwell. Who is what lets an automation that keeps things so
 * tell a person's change from another automation's
 * (docs/SHARED-PARTS-AND-RESERVE.md).
 */
export type GatewayLedger = {
  lastSwitch(device: SavedDeviceId, part: string): LedgerMark | null;
  switched(device: SavedDeviceId, part: string, mark: LedgerMark): void;
  /** Puts back what was marked before a switch the device refused: the mark before it, or none. */
  unswitched(device: SavedDeviceId, part: string, before: LedgerMark | null): void;
  lastWrite(device: SavedDeviceId, attribute: string): LedgerMark | null;
  wrote(device: SavedDeviceId, attribute: string, mark: LedgerMark): void;
};

/** A ledger kept in memory: for tests, and a holder with nowhere else to keep one. */
export function memoryLedger(): GatewayLedger {
  const switches = new Map<string, LedgerMark>();
  const writes = new Map<string, LedgerMark>();
  return {
    lastSwitch: (device, part) => switches.get(`${device}:${part}`) ?? null,
    switched: (device, part, mark) => void switches.set(`${device}:${part}`, mark),
    unswitched: (device, part, before) => void (before ? switches.set(`${device}:${part}`, before) : switches.delete(`${device}:${part}`)),
    lastWrite: (device, attribute) => writes.get(`${device}:${attribute}`) ?? null,
    wrote: (device, attribute, mark) => void writes.set(`${device}:${attribute}`, mark),
  };
}

/** A link from a part, as the gateway walks it. */
export type OutgoingLink = { kind: LinkKind; target: LinkEnd<SavedDeviceId> };

/** What the gateway needs of a device: its session, what it is, and its name for the timeline. */
export type GatewayDevice = {
  name: string;
  session: DeviceSession | null;
  description: DeviceDescription;
  /** Why there is no session, when there is none. */
  offline: string;
};

/** A change to what a device remembers: its settings, as attributes that can be written. */
export type WriteIntent = {
  deviceId: SavedDeviceId;
  /** Only what should change: writing the full set would rewrite every register to change one. */
  patch: Readonly<Record<string, Value>>;
  by: GatewayActor;
  /** The token a refusal handed out, once a person has said yes: required when the patch touches an attribute that can damage the hardware. */
  confirmation?: string;
};

export type WriteResult = {
  outcome: GatewayOutcome;
  detail: string;
  /** What the device reports afterwards. */
  values?: Readonly<Record<string, Value>>;
  /** Refused only because a person has to confirm it: the token to send back with the retry. */
  needsConfirmation?: string;
  /** With `needsConfirmation`: why it matters, as the question a person is asked. */
  reason?: string;
  /**
   * Once written, how much of its dwell is left: the same settings, written
   * again by the same kind of actor sooner, are refused. A screen keeps the
   * control busy that long rather than let a nudge be refused.
   */
  settlingMs?: number;
};

export type GatewayDeps = {
  device: (id: SavedDeviceId) => GatewayDevice | null;
  /** Every link whose source is this part, of any kind. */
  linksFrom: (id: SavedDeviceId, part: string) => readonly OutgoingLink[];
  /** True when writes to this device are refused: every hardware write, when read-only. A simulated device has no hardware. */
  isReadOnly: (deviceId: SavedDeviceId) => boolean;
  /**
   * The home's time: what a pause between switches, how old a reading may
   * be and how long a switch is given to show are measured by, and what the
   * ledger stamps. Real time when not given; a test of simulated devices runs
   * it fast, on a server where nothing reaches hardware.
   */
  clock?: Clock;
  /** What read-only is called where this node runs: a server's mode, or an app's switch. */
  readOnlyReason?: string;
  /**
   * Where the timeline goes: the server's database, or — for a connection an
   * app holds — a queue that goes up to the server.
   */
  record: (entry: AuditRecord) => void;
  policy?: Partial<GatewayPolicy>;
  /**
   * What it remembers of each device: when each part was last switched and
   * each setting last written. The server keeps it in its database, an app in
   * its own storage, so a restart is not a way around the dwell time; tests,
   * and a gateway given none, keep it in memory.
   */
  ledger?: GatewayLedger;
  /** What a device's home has set of the values a declaration may name — how much is a load. What it has not set takes its default. */
  policyValues?: (deviceId: SavedDeviceId) => PolicyValues;
};

/** What a linked part reads that should follow the command: its evidence, and whether it is current. */
type LinkEvidence = { connected: boolean; value: Value; at: string | null; current: boolean };

/** One attribute a command sets, and the value it is to take. */
type Setting = { attribute: AttributeSpec; value: Value };

/** A link from the part commanded, with what its kind says and what its target is called. */
type Linked = { kind: LinkKindSpec; target: LinkEnd<SavedDeviceId>; name: string; expected: Value };

const shown = (value: Value): string => (value === true ? 'on' : value === false ? 'off' : isScalar(value) ? String(value) : JSON.stringify(value));

/**
 * Whether a command is consequential as its declaration says, before links
 * are counted. A condition on what the part reports that cannot be judged —
 * nothing read, or read too long ago — counts as holding: unknown is never
 * taken for the safe answer. A part that does not report it at all (a plug
 * with no meter) makes no claim either way; only a link can make it one.
 */
function declaredConsequence(
  command: CapabilityCommand,
  args: Readonly<Record<string, Value>>,
  read: (means: string) => { value: Value; current: boolean } | null,
  values: PolicyValues
): { matches: boolean; because: string | null } {
  const declared = command.consequential;
  if (!declared) return { matches: false, because: null };
  if (declared === 'always') return { matches: true, because: null };
  if (declared.when && args[declared.when.arg] !== declared.when.is) return { matches: false, because: null };
  if (!declared.if?.length) return { matches: true, because: null };
  let unknown: string | null = null;
  for (const condition of declared.if) {
    const meaning = standardMeaning(condition.means);
    const label = meaning?.label ?? condition.means;
    const reading = read(condition.means);
    if (reading === null) continue;
    const holds = reading.current ? conditionHolds(condition, isScalar(reading.value) ? reading.value : null, values) : null;
    if (holds === true) {
      const value = reading.value;
      const unit = meaning?.type === 'number' ? ` ${meaning.unit}` : '';
      return { matches: true, because: `${label} is ${typeof value === 'number' ? Math.round(value) : shown(value)}${unit}` };
    }
    if (holds === null) unknown ??= reading.value === null ? `${label} is not known` : `${label} was last read too long ago to go by`;
  }
  if (unknown) return { matches: true, because: unknown };
  // Declared, and it matches, but nothing now makes it so: only a link can.
  return { matches: false, because: null };
}

export class ActionGateway {
  #deps: GatewayDeps;
  #policy: GatewayPolicy;
  #record: (entry: AuditRecord) => void;
  #ledger: GatewayLedger;
  #confirmations = new Confirmations();
  /** Serialises everything, so "exactly one command" survives concurrent callers. */
  #gate: Promise<void> = Promise.resolve();
  /**
   * How often each run going now has switched each part, by run and then by
   * part: a run's allowance. Kept in memory only — a run does not outlive
   * the process that ran it: one found unended on start was interrupted,
   * never resumed. Let go when the run ends.
   */
  #runSwitches = new Map<string, Map<string, number>>();

  /** The home's time. */
  get #clock(): Clock {
    return this.#deps.clock ?? REAL_CLOCK;
  }

  #now(): number {
    return this.#clock.now();
  }

  constructor(deps: GatewayDeps) {
    this.#deps = deps;
    this.#policy = { ...DEFAULT_POLICY, ...deps.policy };
    this.#record = deps.record;
    this.#ledger = deps.ledger ?? memoryLedger();
  }

  /**
   * Why a command would draw a store below the home's reserve, in words —
   * "Garage station's charge is 18 %, below the 20 % reserve" — or null when it
   * would not: no reserve set, a command that does not drain as it is called,
   * a part that is no load, or a device with no store of its own. A charge not
   * known, or read too long ago, is below it: unknown is never the safe answer
   * (docs/SHARED-PARTS-AND-RESERVE.md).
   */
  #belowReserve(device: GatewayDevice, intent: CommandIntent, spec: CapabilityCommand, readingsNow: () => readonly Reading[], values: PolicyValues): string | null {
    const reserve = thresholdOf({ policy: 'reserveSoc' }, values);
    if (reserve <= 0 || !spec.drains || intent.args[spec.drains.when.arg] !== spec.drains.when.is) return null;
    const parts = partsOf(device.description);
    if (parts.find((part) => part.id === intent.part)?.energy?.role !== 'load') return null;
    const store = parts.find((part) => part.energy?.role === 'storage' && !part.parent);
    const attribute = store ? attributeMeaning(device.description, store.id, 'charge') : null;
    if (!attribute) return null;
    const reading = readingOf(readingsNow(), attribute.key);
    if (!this.#fresh(attribute, reading) || typeof reading?.value !== 'number') return `${device.name}'s charge is not known now, so the ${reserve} % reserve cannot be kept`;
    return reading.value < reserve ? `${device.name}'s charge is ${Math.round(reading.value)} %, below the ${reserve} % reserve` : null;
  }

  /** A run has ended: what it switched no longer counts against anything. */
  runEnded(runId: string): void {
    this.#runSwitches.delete(runId);
  }

  /** Who last switched a part from here, and when; null, nobody ever has. */
  lastSwitch(deviceId: SavedDeviceId, part: string): LedgerMark | null {
    return this.#ledger.lastSwitch(deviceId, part);
  }

  /** Who last wrote a setting from here, and when; null, nobody ever has. */
  lastWrite(deviceId: SavedDeviceId, attribute: string): LedgerMark | null {
    return this.#ledger.lastWrite(deviceId, attribute);
  }

  /** How many runs the gateway is counting switches for now: for tests. */
  get runsCounted(): number {
    return this.#runSwitches.size;
  }

  /*
    Per device and part, not per gateway. One value shared by every device let a
    switch of plug A start plug B's dwell time, and let B's first switch skip
    the confirmation a new plug needs because A had already been switched.
  */
  #key = (intent: Pick<CommandIntent, 'deviceId' | 'part'>) => `${intent.deviceId}:${intent.part}`;
  #lastSwitchAt = (intent: Pick<CommandIntent, 'deviceId' | 'part'>) => this.#ledger.lastSwitch(intent.deviceId, intent.part)?.at ?? 0;
  #everSwitched = (intent: Pick<CommandIntent, 'deviceId' | 'part'>) => this.#ledger.lastSwitch(intent.deviceId, intent.part) !== null;

  /**
   * One at a time, whatever arrives together.
   *
   * The dwell check reads the last switch, which is not written until several
   * awaits later. Two requests arriving in the same tick therefore both looked,
   * both saw the window clear, and both sent — from the one class that promises
   * exactly one. Serialising rather than rejecting means the second still gets
   * a real answer: it runs after the first and is refused by the dwell check,
   * which is the honest reason.
   */
  #serially<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#gate.then(work, work);
    this.#gate = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  /**
   * Every command: checked and sent in the one line, then verified outside
   * it — waiting for a device to agree holds no other device's command, a
   * person's "off" among them.
   */
  async execute(intent: CommandIntent): Promise<GatewayResult> {
    const sent = await this.#serially(() => this.#execute(intent));
    return 'verify' in sent ? sent.verify() : sent;
  }

  /** A send to a device, held to the time it is given: one that never answers is refused as failed. */
  #within<T>(work: Promise<T>, what: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} did not answer within ${Math.round(this.#policy.sendTimeoutMs / 1000)} s`)), this.#policy.sendTimeoutMs);
    });
    return Promise.race([work, late]).finally(() => clearTimeout(timer));
  }

  async #execute(intent: CommandIntent): Promise<GatewayResult | { verify: () => Promise<GatewayResult> }> {
    const at = new Date(this.#now()).toISOString();
    const device = this.#deps.device(intent.deviceId);
    const partLabel = device ? (partsOf(device.description).find((part) => part.id === intent.part)?.label ?? intent.part) : intent.part;
    const argsShown = Object.values(intent.args).map(shown).join(', ');
    const what = `${intent.part === MAIN_PART ? intent.capability : partLabel} ${argsShown}`.trim();
    const note = (kind: string, summary: string, detail?: unknown) =>
      this.#record({ at: new Date(this.#now()).toISOString(), kind, actor: intent.by, resourceKind: 'device', resource: intent.deviceId, summary, detail });
    const refuse = (detail: string, extra: Partial<GatewayResult> = {}): GatewayResult => {
      this.#record({ at, kind: 'command.refused', actor: intent.by, resourceKind: 'device', resource: intent.deviceId, summary: `${what} refused: ${detail}`, detail: { ...intent, confirmation: undefined } });
      return { outcome: 'refused', detail, ...extra };
    };

    // 1. A part that is here, offers this, and a command it takes, with the arguments it takes.
    if (!device) return refuse('No such device');
    const capability = capabilityIn(device.description, intent.capability);
    if (!capability) return refuse(`"${intent.capability}" is not a capability`);
    const spec = capability.commands[intent.command];
    if (!spec) return refuse(`${intent.capability} has no command "${intent.command}"`);
    if (!capabilitiesOf(device.description, intent.part).includes(intent.capability)) {
      return refuse(`${intent.part === MAIN_PART ? device.name : `"${intent.part}"`} does not offer ${intent.capability}`);
    }
    for (const [name, type] of Object.entries(spec.args)) {
      const checked = checkValue(type, intent.args[name]);
      if (!checked.ok) return refuse(`${name} ${checked.problem}`);
    }
    const extra = Object.keys(intent.args).filter((name) => !(name in spec.args));
    if (extra.length) return refuse(`${intent.capability}.${intent.command} takes no ${extra.join(', ')}`);
    const session = device.session;
    if (!session) return refuse(device.offline);

    const settings: Setting[] = [];
    for (const [argument, attributeName] of Object.entries(spec.sets)) {
      const means = capability.attributes[attributeName]?.means;
      const attribute = means ? attributeMeaning(device.description, intent.part, means) : null;
      if (!attribute) return refuse(`It does not report what ${intent.command} changes, so it cannot be checked`);
      settings.push({ attribute, value: intent.args[argument] ?? null });
    }
    const readingsNow = () => session.readings();
    const current = settings.map((setting) => readingOf(readingsNow(), setting.attribute.key));

    // 2. Policy, evaluated now rather than when anything was configured.
    if (this.#deps.isReadOnly(intent.deviceId)) return refuse(this.#deps.readOnlyReason ?? 'Every write to hardware is refused here: read-only');

    const key = this.#key(intent);
    const sinceLast = this.#now() - this.#lastSwitchAt(intent);
    // Within a run that already switched this part: its allowance, held to the gateway's own gap and ceiling.
    const inRun = intent.run ? (this.#runSwitches.get(intent.run.id)?.get(key) ?? 0) : 0;
    if (intent.run && inRun > 0) {
      const allowed = Math.min(intent.run.switches, this.#policy.runSwitchCeiling);
      if (inRun >= allowed) return refuse(`It has been switched ${inRun} times in this run, as often as it may be`);
      if (sinceLast < this.#policy.runGapMs) {
        return refuse(`Too soon: it was switched ${Math.round(sinceLast / 1000)} s ago in this run, and is given ${Math.round(this.#policy.runGapMs / 1000)} s between switches`, { retryInMs: this.#policy.runGapMs - sinceLast });
      }
    } else {
      // A run switches first as whoever asked for it would: a person as a person, an assistant as an assistant.
      const actor = intent.run?.askedBy ?? intent.by.kind;
      const dwell = actor === 'automation' ? this.#policy.automationDwellMs : actor === 'agent' ? this.#policy.agentDwellMs : this.#policy.personDwellMs;
      if (this.#lastSwitchAt(intent) > 0 && sinceLast < dwell) {
        // Said as what it is: a pause that protects the relay and what it feeds, and how long is left of it.
        return refuse(`Too soon: it was switched ${Math.round(sinceLast / 1000)} s ago, and is given ${Math.round(dwell / 1000)} s between switches. Try again in ${Math.ceil((dwell - sinceLast) / 1000)} s`);
      }
    }

    // 3. Freshness: acting on stale readings is how mains is cut at exactly the wrong moment.
    if (current.some((reading) => reading === null || reading.value === null)) return refuse('Its current state is not known, so it is not switched blind');
    if (settings.some((setting, index) => !this.#fresh(setting.attribute, current[index]!))) return refuse('Its reading is stale: refusing to switch blind', { stale: [{ device: intent.deviceId, part: intent.part }] });

    // Every link from this part whose kind goes through this capability: its target must be answering, now.
    const links: Linked[] = [];
    for (const link of this.#deps.linksFrom(intent.deviceId, intent.part)) {
      const kind = linkKindSpec(link.kind);
      if (kind.from !== intent.capability) continue;
      const follows = settings.find((setting) => setting.attribute.means === kind.evidence.follows);
      const target = this.#deps.device(link.target.device);
      links.push({ kind, target: link.target, name: target ? this.#partName(target, link.target.part) : 'a device that is gone', expected: follows?.value ?? null });
    }
    for (const link of links) {
      const evidence = this.#evidence(link);
      if (!evidence || !evidence.connected || evidence.at === null || evidence.value === null) {
        return refuse(`${link.name}, which it ${link.kind.verb}, is not answering: refusing to act without its own reading`);
      }
      if (!evidence.current) return refuse(`The reading of ${link.name}, which it ${link.kind.verb}, is stale: refusing to act blind`, { stale: [link.target] });
    }

    // 4. A deliberate act where one matters, as the capability and the link kinds declare it.
    const partValue = (means: string) => {
      const attribute = attributeMeaning(device.description, intent.part, means);
      if (!attribute) return null;
      const reading = readingOf(readingsNow(), attribute.key);
      return { value: reading?.value ?? null, current: this.#fresh(attribute, reading) };
    };
    const values = this.#deps.policyValues?.(intent.deviceId) ?? {};
    const declared = declaredConsequence(spec, intent.args, partValue, values);
    const whenMatches = spec.consequential !== undefined && (spec.consequential === 'always' || !spec.consequential.when || intent.args[spec.consequential.when.arg] === spec.consequential.when.is);
    const consequentialLink = links.find((link) => link.kind.consequential) ?? null;
    const firstThroughLink = consequentialLink !== null && !this.#everSwitched(intent);
    const consequential = declared.matches || (whenMatches && consequentialLink !== null);
    const subject = subjectOf({ device: intent.deviceId, part: intent.part, capability: intent.capability, command: intent.command, args: intent.args, by: intent.by });
    const why = firstThroughLink
      ? `This ${consequentialLink.kind.verb} ${consequentialLink.name} and has never been switched from here: confirm it is the right one`
      : consequentialLink && whenMatches
        ? `This ${consequentialLink.kind.verb} ${consequentialLink.name}`
        : (declared.because ?? 'This needs confirming');
    // An agent cannot say yes for a person: what needs one is theirs to do, in the app, and the refusal says so.
    if (intent.by.kind === 'agent' && (consequential || firstThroughLink)) return refuse(`A person has to do this, in the app: it needs their confirmation. ${why}.`);
    // The home's reserve, for what drains a store — unless it is already so: what was not drained is not now.
    const alreadySo = settings.every((setting) => readingOf(readingsNow(), setting.attribute.key)?.value === setting.value);
    const reserve = alreadySo ? null : this.#belowReserve(device, intent, spec, readingsNow, values);
    if (reserve && intent.by.kind !== 'person') return refuse(`${reserve}: it is kept for when it is needed, and only a person may draw on it`);
    const asks = consequential || firstThroughLink || reserve !== null;
    if (intent.by.kind === 'person' && asks && !this.#confirmations.accept(intent.confirmation, subject)) {
      const said = [consequential || firstThroughLink ? why : null, reserve].filter((reason) => reason !== null).join('. ');
      return { ...refuse(`This action needs explicit confirmation. ${said}.`), needsConfirmation: this.#confirmations.ask(subject), reason: `${said}.` };
    }

    const agrees = () => settings.every((setting) => readingOf(readingsNow(), setting.attribute.key)?.value === setting.value);
    const linksAgree = (after: number | null) =>
      links.every((link) => {
        const evidence = this.#evidence(link);
        const readAt = evidence?.at ? Date.parse(evidence.at) : Number.NaN;
        // Only a reading taken after the command counts, once one was sent. The one
        // cached from before says what was — which, cutting mains to a station that
        // had already lost it, looked exactly like agreement.
        return Boolean(evidence?.connected && (after === null || readAt > after) && evidence.value === link.expected);
      });
    if (settings.length && agrees()) {
      const linkAgreed = links.length ? linksAgree(null) : undefined;
      // Nothing sent, and said so: a receipt for every press, this one too.
      note('command.already', `${device.name}: ${what} not sent: it is already ${argsShown}`, { part: intent.part, capability: intent.capability, command: intent.command, args: intent.args });
      return {
        outcome: linkAgreed === false ? 'unverified' : 'verified',
        detail: linkAgreed === false ? `It is already ${argsShown}, but ${links.map((link) => link.name).join(' and ')} does not agree` : `Already ${argsShown}`,
        deviceAgreed: true,
        linkAgreed,
      };
    }

    // 5. The intent, before anything physical happens.
    note('command.intent', `${device.name}: ${what} requested: ${intent.reason}`, {
      part: intent.part,
      capability: intent.capability,
      command: intent.command,
      args: intent.args,
      before: Object.fromEntries(settings.map((setting, index) => [setting.attribute.key, current[index]?.value ?? null])),
      linked: links.length ? links.map((link) => ({ kind: link.kind.verb, deviceId: link.target.device, part: link.target.part, value: this.#evidence(link)?.value ?? null })) : undefined,
    });

    // 6. Exactly one command. Marked before it is sent: a send that never answers may have switched it.
    const marked = this.#ledger.lastSwitch(intent.deviceId, intent.part);
    this.#ledger.switched(intent.deviceId, intent.part, { at: this.#now(), by: intent.by });
    const counts = intent.run ? (this.#runSwitches.get(intent.run.id) ?? new Map<string, number>()) : null;
    if (intent.run && counts) this.#runSwitches.set(intent.run.id, counts.set(key, inRun + 1));
    const sentAt = this.#now();
    let result: Awaited<ReturnType<typeof session.command>>;
    let refused = false;
    try {
      result = await this.#within(session.command({ part: intent.part, capability: intent.capability, command: intent.command, args: intent.args }), device.name);
      // Its own answer that it did not take it: nothing was switched.
      refused = !result.accepted;
    } catch (error) {
      result = { accepted: false, error: (error as Error).message };
    }
    if (!result.accepted) {
      if (refused) {
        // A refusal switched nothing: the dwell and the run's allowance are not spent on it. One that
        // never answered, or broke off, keeps them — it may have switched.
        this.#ledger.unswitched(intent.deviceId, intent.part, marked);
        if (counts) counts.set(key, inRun);
      }
      note('command.failed', `${device.name}: ${what} failed: ${result.error}`);
      return { outcome: 'failed', detail: result.error };
    }

    // 7. The proofs, recorded separately — outside the line, so they hold no other command.
    return { verify: () => this.#verified({ device, links, settings, sentAt, argsShown, note, agrees, linksAgree }) };
  }

  async #verified(sent: {
    device: GatewayDevice;
    links: Linked[];
    settings: readonly unknown[];
    sentAt: number;
    argsShown: string;
    note: (kind: string, summary: string, detail?: unknown) => void;
    agrees: () => boolean;
    linksAgree: (after: number | null) => boolean;
  }): Promise<GatewayResult> {
    const { device, links, settings, sentAt, argsShown, note, agrees, linksAgree } = sent;
    // A command that sets nothing it reports has nothing to agree on: sent, and not claimed.
    if (!settings.length) {
      const detail = 'It accepted the command; it reports nothing that would show it';
      note('command.unverified', `${device.name}: ${detail}`, { deviceAgreed: false });
      return { outcome: 'unverified', detail, deviceAgreed: false };
    }
    const deviceAgreed = await this.#eventually(agrees);
    const linkAgreed = links.length ? await this.#eventually(() => linksAgree(sentAt)) : undefined;

    const outcome: GatewayOutcome = deviceAgreed && linkAgreed !== false ? 'verified' : 'unverified';
    const evidenceOf = (link: Linked) => standardMeaning(link.kind.evidence.means)?.label.toLowerCase() ?? link.kind.evidence.means;
    const detail = !deviceAgreed
      ? 'It accepted the command but does not report the new state'
      : linkAgreed === false
        ? `It says ${argsShown}, but ${links.map((link) => `${link.name} does not report ${evidenceOf(link)} as ${shown(link.expected)}`).join(', and ')}`
        : links.length
          ? `Done — ${argsShown}, confirmed by the device and by ${links.map((link) => `${link.name} (${evidenceOf(link)}: ${shown(link.expected)})`).join(' and ')}`
          : `Done — ${argsShown}, confirmed by the device`;

    // 8. The outcome, with every piece of evidence.
    note(`command.${outcome}`, `${device.name}: ${detail}`, { deviceAgreed, linkAgreed });
    return { outcome, detail, deviceAgreed, linkAgreed };
  }

  /** "Garage station — Mains", or the device's name for its main part. */
  #partName(device: GatewayDevice, part: string): string {
    return partName(device.name, part, partsOf(device.description).find((candidate) => candidate.id === part)?.label ?? part);
  }

  /**
   * What a linked part says, from its own session: the attribute its link kind
   * names as evidence, on the part the link reaches — which must still offer
   * what the kind reaches.
   */
  #evidence(link: Pick<Linked, 'kind' | 'target'>): LinkEvidence | null {
    const target = this.#deps.device(link.target.device);
    const session = target?.session;
    if (!target || !session) return null;
    if (!capabilitiesOf(target.description, link.target.part).includes(link.kind.to)) return null;
    const attribute = attributeMeaning(target.description, link.target.part, link.kind.evidence.means);
    if (!attribute) return null;
    const reading = readingOf(session.readings(), attribute.key);
    return {
      connected: session.health().status === 'connected',
      value: reading?.value ?? null,
      at: reading?.at ?? null,
      current: this.#fresh(attribute, reading),
    };
  }

  /**
   * Current for its attribute, and no older than the policy allows anything
   * to be acted on — counted from when it was last said to hold: observed, or
   * confirmed since (`Reading.confirmedAt`).
   */
  #fresh(attribute: AttributeSpec, reading: Pick<Reading, 'at' | 'confirmedAt'> | null): boolean {
    const age = Math.min(this.#ageOf(reading?.at ?? null), this.#ageOf(reading?.confirmedAt ?? null));
    return age <= Math.min(this.#policy.maxDataAgeMs, currentForOf(attribute));
  }

  /** Waits for `check`, looking at what is cached — cheap, so often enough to answer soon. */
  async #eventually(check: () => boolean): Promise<boolean> {
    const deadline = this.#now() + this.#policy.verifyTimeoutMs;
    while (this.#now() < deadline) {
      if (check()) return true;
      await sleep(this.#clock, Math.min(1_000, this.#policy.verifyTimeoutMs / 5));
    }
    return check();
  }

  /**
   * A write of what a device remembers, with the same care as a command
   * (docs/ARCHITECTURE.md §4.6): only attributes its description says can be
   * written, held to their types; refused while read-only; one that can damage
   * the hardware confirmed by a person and never changed by an automation; then
   * verified by reading it back, and audited — the intent before anything is
   * sent, and the outcome.
   */
  async write(intent: WriteIntent): Promise<WriteResult> {
    const sent = await this.#serially(() => this.#write(intent));
    return 'verify' in sent ? sent.verify() : sent;
  }

  async #write(intent: WriteIntent): Promise<WriteResult | { verify: () => Promise<WriteResult> }> {
    const device = this.#deps.device(intent.deviceId);
    const keys = Object.keys(intent.patch);
    const refuse = (detail: string, extra: Partial<WriteResult> = {}): WriteResult => {
      this.#record({ at: new Date(this.#now()).toISOString(), kind: 'settings.refused', actor: intent.by, resourceKind: 'device', resource: intent.deviceId, summary: `Changing ${keys.join(', ')} refused: ${detail}` });
      return { outcome: 'refused', detail, ...extra };
    };

    if (!device) return refuse('No such device');
    const session = device.session;
    if (!keys.length) return refuse('Nothing to change');
    const writable = new Map(device.description.attributes.filter((attribute) => attribute.access === 'write').map((attribute) => [attribute.key, attribute]));
    if (!writable.size) return refuse('It has no settings to change');
    const unknown = keys.filter((key) => !writable.has(key));
    if (unknown.length) return refuse(`No such setting: ${unknown.join(', ')}`);

    const changed: Record<string, Value> = {};
    for (const key of keys) {
      const attribute = writable.get(key)!;
      const checked = checkValue(attribute.value, intent.patch[key]);
      if (!checked.ok) return refuse(`${attribute.label} ${checked.problem}`);
      changed[key] = checked.value;
    }
    if (!session?.write) return refuse(session ? 'It cannot be written to' : device.offline);

    if (this.#deps.isReadOnly(intent.deviceId)) return refuse(this.#deps.readOnlyReason ?? 'Every write to hardware is refused here: read-only');

    // A setting written moments ago is still settling: one write per setting per dwell, whoever asks.
    const writeDwell = intent.by.kind === 'automation' ? this.#policy.automationDwellMs : intent.by.kind === 'agent' ? this.#policy.agentDwellMs : this.#policy.userWriteDwellMs;
    const settling = keys
      .map((key) => ({ key, since: this.#now() - (this.#ledger.lastWrite(intent.deviceId, key)?.at ?? 0) }))
      .find(({ since }) => since < writeDwell);
    if (settling) return refuse(`Too soon: ${writable.get(settling.key)!.label} was changed ${Math.round(settling.since / 1000)} s ago; ${Math.ceil((writeDwell - settling.since) / 1000)} s of the dwell time remains`);

    const risky = keys.filter((key) => writable.get(key)!.dangerous);
    const labelled = (list: readonly string[]) => list.map((key) => writable.get(key)?.label ?? key).join(', ');
    if (risky.length && intent.by.kind !== 'person') return refuse(`${intent.by.kind === 'agent' ? 'An assistant' : 'An automation'} may not change ${labelled(risky)}: it can damage the hardware. A person can, in the app`);
    const subject = subjectOf({ device: intent.deviceId, patch: changed, by: intent.by });
    if (risky.length && !this.#confirmations.accept(intent.confirmation, subject)) {
      const labels = risky.map((key) => writable.get(key)!.label).join(', ');
      const reason = `${labels} can damage the hardware if set wrongly.`;
      return refuse(`This needs explicit confirmation. ${reason}`, { needsConfirmation: this.#confirmations.ask(subject), reason });
    }

    const note = (kind: string, summary: string, detail?: unknown) =>
      this.#record({ at: new Date(this.#now()).toISOString(), kind, actor: intent.by, resourceKind: 'device', resource: intent.deviceId, summary, detail });
    // The timeline in the words the screens use: "Brightness to 8", "After a power cut to Stay off".
    const described = keys
      .map((key) => {
        const attribute = writable.get(key)!;
        const value = changed[key];
        const shown =
          attribute.value.type === 'enum'
            ? (attribute.value.options.find((option) => option.value === value)?.label ?? String(value))
            : attribute.value.type === 'boolean'
              ? value ? 'on' : 'off'
              : `${String(value)}${attribute.value.type === 'number' && attribute.value.unit ? ` ${attribute.value.unit}` : ''}`;
        return `${attribute.label} to ${shown}`;
      })
      .join(', ');
    note('settings.intent', `${device.name}: changing ${described}`, { patch: changed });

    const writtenAt = this.#now();
    const settlingMs = () => Math.max(0, writeDwell - (this.#now() - writtenAt));
    for (const key of keys) this.#ledger.wrote(intent.deviceId, key, { at: writtenAt, by: intent.by });
    try {
      await this.#within(session.write(changed), device.name);
    } catch (error) {
      const detail = (error as Error).message;
      note('settings.failed', `${device.name}: changing ${described} failed: ${detail}`);
      return { outcome: 'failed', detail, settlingMs: settlingMs() };
    }

    // The device's own word, read back: what it reports now, not what was sent.
    // Its readings alone: what its session answered the write with is the session's word, not the device's —
    // one that hands back what it was given would always agree. Only what changed was written, so a
    // reading that agrees was not there before it.
    const reported = () => Object.fromEntries(keys.map((key) => [key, readingOf(session.readings(), key)?.value ?? null]));
    // As values, not as text: `[1,2]` is not `"1,2"`, and `1` is not `"1"`.
    const agrees = () => {
      const now = reported();
      return keys.every((key) => now[key] !== null && JSON.stringify(now[key]) === JSON.stringify(changed[key]));
    };
    return {
      verify: async () => {
        const verified = agrees() || (await this.#eventually(agrees));
        const detail = verified ? `Changed ${described}, confirmed by the device` : `It accepted the change, but does not report ${labelled(keys)} as set`;
        note(`settings.${verified ? 'verified' : 'unverified'}`, `${device.name}: ${detail}`, { patch: changed });
        return { outcome: verified ? 'verified' : 'unverified', detail, values: reported(), settlingMs: settlingMs() };
      },
    };
  }

  #ageOf(iso: string | null): number {
    if (iso === null) return Number.POSITIVE_INFINITY;
    const at = new Date(iso).getTime();
    return Number.isFinite(at) ? this.#now() - at : Number.POSITIVE_INFINITY;
  }
}
