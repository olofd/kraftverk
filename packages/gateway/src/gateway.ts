import {
  attributeMeaning,
  capabilitiesOf,
  capabilitySpec,
  checkValue,
  isCapability,
  LINK_KINDS,
  MAIN_PART,
  partsOf,
  readingOf,
  type AttributeSpec,
  type CapabilityName,
  type DeviceDescription,
  type DeviceSession,
  type SavedDeviceId,
  type Value,
} from '@kraftverk/device-sdk';

/** One line in the audit timeline, wherever the holder keeps it. */
export type AuditEntry = {
  at: string;
  kind: string;
  actor: string;
  resource?: string;
  summary: string;
  detail?: unknown;
};

/**
 * The only path a command to hardware takes (docs/ARCHITECTURE.md §4.6).
 *
 * Every command — from a screen, an automation or a bridge — and every write
 * of a device's own settings comes here, and everything it has to survive
 * lives here: the capability's safety level, read-only mode, dwell time, the
 * freshness of what the decision rests on, and — the part that makes it more
 * than a wrapper — verification. A device saying "done" is not proof. Reading
 * back what the command sets is one proof; and switching a plug that `feeds` a
 * station is proven only by the station's own mains reading agreeing, from a
 * reading it took after the switch.
 *
 * It names no capability: what a command takes, what it sets and how careful to
 * be come from the capability library, and what a device reads from its
 * description, so a new capability needs no edit here.
 */

/** What a person sends to say "yes, I mean it". */
export const CONFIRMATION = 'confirm';

export type CommandIntent = {
  deviceId: SavedDeviceId;
  /** The part it is for: `main`, `outlet.ac`. */
  part: string;
  capability: CapabilityName;
  command: string;
  args: Readonly<Record<string, Value>>;
  reason: string;
  /** The kind of caller. It decides policy — a person confirms, an automation has its own dwell time. */
  actor: 'user' | 'automation';
  /**
   * Who, for the audit trail: an account name, or "automation:a-…". Kept apart
   * from `actor`, which is a kind and drives policy — a name must never be able
   * to change which rules apply.
   */
  by: string;
  /** Required when turning off something that matters, and for the first switch of a feeding plug. */
  confirmation?: string;
};

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
  /** The device it feeds agrees — for a part that feeds one. */
  linkAgreed?: boolean;
  /**
   * Refused only because a person has to confirm it: ask, and send it again
   * with `confirmation: CONFIRMATION`. The detail says why it matters.
   */
  needsConfirmation?: true;
};

export type GatewayPolicy = {
  /** How old a reading may be and still be acted on. */
  maxDataAgeMs: number;
  /** Minimum gap between an automation's changes to one part. */
  automationDwellMs: number;
  /** A much shorter guard for a person tapping a button, so the acceptance drill is possible. */
  userDwellMs: number;
  /** How long the device and the device it feeds are given to agree. */
  verifyTimeoutMs: number;
  /** A part drawing more than this is carrying a load: turning it off needs confirmation. */
  loadWatts: number;
};

export const DEFAULT_POLICY: GatewayPolicy = {
  maxDataAgeMs: 60_000,
  automationDwellMs: 10 * 60_000,
  userDwellMs: 5_000,
  verifyTimeoutMs: 30_000,
  loadWatts: 5,
};

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
  actor: 'user' | 'automation';
  by: string;
  /** Required when the patch touches an attribute that can damage the hardware. */
  confirmation?: string;
};

export type WriteResult = {
  outcome: GatewayOutcome;
  detail: string;
  /** What the device reports afterwards. */
  values?: Readonly<Record<string, Value>>;
  /** Refused only because a person has to confirm it. */
  needsConfirmation?: true;
};

export type GatewayDeps = {
  device: (id: SavedDeviceId) => GatewayDevice | null;
  /** The device a device's main part feeds, from the links. */
  feeds: (id: SavedDeviceId) => SavedDeviceId | null;
  /** True when writes to this device are refused: every hardware write, when read-only. A simulated device has no hardware. */
  isReadOnly: (deviceId: SavedDeviceId) => boolean;
  /** What read-only is called where this holder runs: the server's mode, or an app's switch. */
  readOnlyReason?: string;
  /**
   * Where the timeline goes: the server's database, or — for a connection an
   * app holds — a queue that goes up to the server.
   */
  record: (entry: AuditEntry) => void;
  policy?: Partial<GatewayPolicy>;
  /**
   * Where each part's last switch is remembered. The server passes its
   * database, so a restart is not a way around the dwell time; tests keep it
   * in memory.
   */
  memory?: { get(key: string): string | null; set(key: string, value: string): void };
};

/** What a linked device reads that should follow the switch: its evidence. */
type LinkEvidence = { connected: boolean; value: boolean | null; at: string | null };

/** One attribute a command sets, and the value it is to take. */
type Setting = { attribute: AttributeSpec; value: Value };

const shown = (value: Value): string => (value === true ? 'on' : value === false ? 'off' : String(value));

export class ActionGateway {
  #deps: GatewayDeps;
  #policy: GatewayPolicy;
  #record: (entry: AuditEntry) => void;
  #memory: NonNullable<GatewayDeps['memory']>;
  /** Serialises everything, so "exactly one command" survives concurrent callers. */
  #gate: Promise<void> = Promise.resolve();

  constructor(deps: GatewayDeps) {
    this.#deps = deps;
    this.#policy = { ...DEFAULT_POLICY, ...deps.policy };
    this.#record = deps.record;
    const kept = new Map<string, string>();
    this.#memory = deps.memory ?? { get: (key) => kept.get(key) ?? null, set: (key, value) => void kept.set(key, value) };
  }

  /*
    Per device and part, not per gateway. One value shared by every device let a
    switch of plug A start plug B's dwell time, and let B's first switch skip
    the confirmation a new plug needs because A had already been switched.
  */
  #key = (intent: Pick<CommandIntent, 'deviceId' | 'part'>) => `${intent.deviceId}:${intent.part}`;
  #lastSwitchAt = (key: string) => Number(this.#memory.get(`gateway.lastSwitchAt.${key}`) ?? 0) || 0;
  #everSwitched = (key: string) => this.#memory.get(`gateway.everSwitched.${key}`) === '1';
  #switched(key: string, at: number): void {
    this.#memory.set(`gateway.lastSwitchAt.${key}`, String(at));
    this.#memory.set(`gateway.everSwitched.${key}`, '1');
  }

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

  execute(intent: CommandIntent): Promise<GatewayResult> {
    return this.#serially(() => this.#execute(intent));
  }

  async #execute(intent: CommandIntent): Promise<GatewayResult> {
    const at = new Date().toISOString();
    const device = this.#deps.device(intent.deviceId);
    const partLabel = device ? (partsOf(device.description).find((part) => part.id === intent.part)?.label ?? intent.part) : intent.part;
    const argsShown = Object.values(intent.args).map(shown).join(', ');
    const what = `${intent.part === MAIN_PART ? intent.capability : partLabel} ${argsShown}`.trim();
    const note = (kind: string, summary: string, detail?: unknown) =>
      this.#record({ at: new Date().toISOString(), kind, actor: intent.by, resource: intent.deviceId, summary, detail });
    const refuse = (detail: string): GatewayResult => {
      this.#record({ at, kind: 'command.refused', actor: intent.by, resource: intent.deviceId, summary: `${what} refused: ${detail}`, detail: intent });
      return { outcome: 'refused', detail };
    };

    // 1. A part that is here, offers this, and a command it takes, with the arguments it takes.
    if (!device) return refuse('No such device');
    if (!isCapability(intent.capability)) return refuse(`"${intent.capability}" is not a capability`);
    const spec = capabilitySpec(intent.capability).commands[intent.command];
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
      const means = capabilitySpec(intent.capability).attributes[attributeName]?.means;
      const attribute = means ? attributeMeaning(device.description, intent.part, means) : null;
      if (!attribute) return refuse(`It does not report what ${intent.command} changes, so it cannot be checked`);
      settings.push({ attribute, value: intent.args[argument] ?? null });
    }
    const readingsNow = () => session.readings();
    const current = settings.map((setting) => readingOf(readingsNow(), setting.attribute.key));

    // 2. Policy, evaluated now rather than when anything was configured.
    if (this.#deps.isReadOnly(intent.deviceId)) return refuse(this.#deps.readOnlyReason ?? 'The server is in read-only mode');

    const key = this.#key(intent);
    const dwell = intent.actor === 'automation' ? this.#policy.automationDwellMs : this.#policy.userDwellMs;
    const sinceLast = Date.now() - this.#lastSwitchAt(key);
    if (this.#lastSwitchAt(key) > 0 && sinceLast < dwell) {
      return refuse(`Too soon: ${Math.ceil((dwell - sinceLast) / 1000)} s of the dwell time remains`);
    }

    // 3. Freshness: acting on stale readings is how mains is cut at exactly the wrong moment.
    if (current.some((reading) => reading === null || reading.value === null)) return refuse('Its current state is not known, so it is not switched blind');
    if (current.some((reading) => this.#ageOf(reading!.at) > this.#policy.maxDataAgeMs)) return refuse('Its reading is stale: refusing to switch blind');

    const fed = intent.part === MAIN_PART && LINK_KINDS.feeds.from === intent.capability ? this.#deps.feeds(intent.deviceId) : null;
    const linked = fed ? this.#evidence(fed) : null;
    if (fed) {
      if (!linked || !linked.connected || linked.at === null || linked.value === null) {
        return refuse('The device it feeds is not answering: refusing to switch without its own reading of mains');
      }
      if (this.#ageOf(linked.at) > this.#policy.maxDataAgeMs) return refuse('The reading of the device it feeds is stale: refusing to switch blind');
    }

    // 4. A deliberate act where one matters: turning off what feeds a device or
    //    carries a load, and the first switch of a feeding part.
    const turningOff = settings.some((setting) => setting.value === false);
    const load = this.#watts(device.description, session, intent.part);
    const critical = fed !== null || load > this.#policy.loadWatts;
    const needsConfirmation =
      intent.actor === 'user' &&
      (spec.safety === 'confirm' || (spec.safety === 'confirm-off-when-critical' && ((turningOff && critical) || (fed !== null && !this.#everSwitched(key)))));
    if (needsConfirmation && intent.confirmation !== CONFIRMATION) {
      const fedName = fed ? (this.#deps.device(fed)?.name ?? 'the device it feeds') : null;
      const why =
        fedName && !this.#everSwitched(key)
          ? `This feeds ${fedName} and has never been switched from here: confirm it is the right one`
          : fedName
            ? `This cuts mains to ${fedName}`
            : load > this.#policy.loadWatts
              ? `It is carrying ${Math.round(load)} W`
              : 'This needs confirming';
      return { ...refuse(`This action needs explicit confirmation. ${why}.`), needsConfirmation: true };
    }

    const agrees = () => settings.every((setting) => readingOf(readingsNow(), setting.attribute.key)?.value === setting.value);
    const expected = settings.find((setting) => typeof setting.value === 'boolean')?.value as boolean | undefined;
    if (agrees()) {
      const linkAgreed = linked && expected !== undefined ? linked.value === expected : undefined;
      return {
        outcome: linkAgreed === false ? 'unverified' : 'verified',
        detail: linkAgreed === false ? `It is already ${argsShown}, but the device it feeds does not agree` : `Already ${argsShown}`,
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
      linked: linked ? { deviceId: fed, value: linked.value } : undefined,
    });

    // 6. Exactly one command.
    this.#switched(key, Date.now());
    const sentAt = Date.now();
    const result = await session.command({ part: intent.part, capability: intent.capability, command: intent.command, args: intent.args });
    if (!result.accepted) {
      note('command.failed', `${device.name}: ${what} failed: ${result.error}`);
      return { outcome: 'failed', detail: result.error };
    }

    // 7. The proofs, recorded separately.
    const deviceAgreed = await this.#eventually(agrees);
    const linkAgreed =
      fed && expected !== undefined
        ? await this.#eventually(() => {
            const reading = this.#evidence(fed);
            const readAt = reading?.at ? Date.parse(reading.at) : Number.NaN;
            // Only a reading taken after the switch counts. The one cached from
            // before says what mains was — which, cutting mains to a station that
            // had already lost it, looked exactly like agreement.
            return Boolean(reading?.connected && readAt > sentAt && reading.value === expected);
          })
        : undefined;

    const outcome: GatewayOutcome = deviceAgreed && linkAgreed !== false ? 'verified' : 'unverified';
    const detail = !deviceAgreed
      ? 'It accepted the command but does not report the new state'
      : linkAgreed === false
        ? `It says ${argsShown}, but the device it feeds has not seen mains ${expected ? 'return' : 'go'}`
        : fed
          ? `Mains ${expected ? 'restored' : 'removed'}, confirmed by both devices`
          : `Done — ${argsShown}, confirmed by the device`;

    // 8. The outcome, with every piece of evidence.
    note(`command.${outcome}`, `${device.name}: ${detail}`, { deviceAgreed, linkAgreed });
    return { outcome, detail, deviceAgreed, linkAgreed };
  }

  /** What a part draws, from the attribute that means `power.draw` on it; 0 when it has none or has not said. */
  #watts(description: DeviceDescription, session: DeviceSession, part: string): number {
    const attribute = attributeMeaning(description, part, 'power.draw');
    const value = attribute ? readingOf(session.readings(), attribute.key)?.value : null;
    return typeof value === 'number' ? value : 0;
  }

  /**
   * What a fed device says, from its own session: the attribute a feeds link
   * names as its evidence, on the part that offers what the link reaches.
   */
  #evidence(id: SavedDeviceId): LinkEvidence | null {
    const target = this.#deps.device(id);
    const session = target?.session;
    if (!target || !session) return null;
    const kind = LINK_KINDS.feeds;
    const part = partsOf(target.description).find((candidate) => capabilitiesOf(target.description, candidate.id).includes(kind.to));
    const attribute = part ? attributeMeaning(target.description, part.id, kind.evidence) : null;
    if (!attribute) return null;
    const reading = readingOf(session.readings(), attribute.key);
    return {
      connected: session.health().status === 'connected',
      value: typeof reading?.value === 'boolean' ? reading.value : null,
      at: reading?.at ?? null,
    };
  }

  /** Waits for `check`, looking at what is cached — cheap, so often enough to answer soon. */
  async #eventually(check: () => boolean): Promise<boolean> {
    const deadline = Date.now() + this.#policy.verifyTimeoutMs;
    while (Date.now() < deadline) {
      if (check()) return true;
      await new Promise((resolve) => setTimeout(resolve, Math.min(1_000, this.#policy.verifyTimeoutMs / 5)));
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
  write(intent: WriteIntent): Promise<WriteResult> {
    return this.#serially(() => this.#write(intent));
  }

  async #write(intent: WriteIntent): Promise<WriteResult> {
    const device = this.#deps.device(intent.deviceId);
    const keys = Object.keys(intent.patch);
    const refuse = (detail: string, extra: Partial<WriteResult> = {}): WriteResult => {
      this.#record({ at: new Date().toISOString(), kind: 'settings.refused', actor: intent.by, resource: intent.deviceId, summary: `Changing ${keys.join(', ')} refused: ${detail}` });
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

    if (this.#deps.isReadOnly(intent.deviceId)) return refuse(this.#deps.readOnlyReason ?? 'The server is in read-only mode');

    const risky = keys.filter((key) => writable.get(key)!.dangerous);
    if (risky.length && intent.actor === 'automation') return refuse(`An automation may not change ${risky.join(', ')}: it can damage the hardware`);
    if (risky.length && intent.confirmation !== CONFIRMATION) {
      const labels = risky.map((key) => writable.get(key)!.label).join(', ');
      return refuse(`This needs explicit confirmation. ${labels} can damage the hardware if set wrongly.`, { needsConfirmation: true });
    }

    const note = (kind: string, summary: string, detail?: unknown) =>
      this.#record({ at: new Date().toISOString(), kind, actor: intent.by, resource: intent.deviceId, summary, detail });
    note('settings.intent', `${device.name}: changing ${keys.join(', ')}`, { patch: changed });

    let values: Readonly<Record<string, Value>>;
    try {
      values = await session.write(changed);
    } catch (error) {
      const detail = (error as Error).message;
      note('settings.failed', `${device.name}: changing ${keys.join(', ')} failed: ${detail}`);
      return { outcome: 'failed', detail };
    }

    // The device's own word, read back: what it reports now, not what was sent.
    const reported = () => Object.fromEntries(keys.map((key) => [key, readingOf(session.readings(), key)?.value ?? values[key] ?? null]));
    const agrees = () => keys.every((key) => String(reported()[key]) === String(changed[key]));
    const verified = agrees() || (await this.#eventually(agrees));
    const detail = verified ? `Changed ${keys.join(', ')}, confirmed by the device` : `It accepted the change, but does not report ${keys.join(', ')} as set`;
    note(`settings.${verified ? 'verified' : 'unverified'}`, `${device.name}: ${detail}`, { patch: changed });
    return { outcome: verified ? 'verified' : 'unverified', detail, values: reported() };
  }

  #ageOf(iso: string | null): number {
    if (iso === null) return Number.POSITIVE_INFINITY;
    const at = new Date(iso).getTime();
    return Number.isFinite(at) ? Date.now() - at : Number.POSITIVE_INFINITY;
  }
}
