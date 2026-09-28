import {
  CAPABILITIES,
  type AcInputCapability,
  type CapabilityName,
  type DeviceSession,
  type OutletsCapability,
  type SavedDeviceId,
  type SwitchCapability,
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
 * Every capability command — from a screen or an automation — comes here, and
 * everything a command has to survive lives here: the capability's safety
 * level, read-only mode, dwell time, the freshness of what the decision rests
 * on, and — the part that makes it more than a wrapper — verification. A device
 * saying "done" is not proof. Its own readback is one proof; and switching a
 * plug that `feeds` a station is proven only by the station's own AC input
 * agreeing, from a reading it took after the switch.
 */

/** What a person sends to say "yes, I mean it". */
export const CONFIRMATION = 'confirm';

export type CommandIntent = {
  deviceId: SavedDeviceId;
  capability: CapabilityName;
  /** The capability's command. `set` is the only one today. */
  command: string;
  /** Which part of the device, for a capability with several: an outlet id. */
  target?: string;
  value: boolean;
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
  /** The station a plug feeds agrees — for a plug that feeds one. */
  stationAgreed?: boolean;
  /**
   * Refused only because a person has to confirm it: ask, and send it again
   * with `confirmation: CONFIRMATION`. The detail says why it matters.
   */
  needsConfirmation?: true;
};

export type GatewayPolicy = {
  /** How old a reading may be and still be acted on. */
  maxDataAgeMs: number;
  /** Minimum gap between an automation's changes to one device. */
  automationDwellMs: number;
  /** A much shorter guard for a person tapping a button, so the acceptance drill is possible. */
  userDwellMs: number;
  /** How long the device and the station it feeds are given to agree. */
  verifyTimeoutMs: number;
  /** An outlet drawing more than this is carrying a load: turning it off needs confirmation. */
  loadWatts: number;
};

export const DEFAULT_POLICY: GatewayPolicy = {
  maxDataAgeMs: 60_000,
  automationDwellMs: 10 * 60_000,
  userDwellMs: 5_000,
  verifyTimeoutMs: 30_000,
  loadWatts: 5,
};

/** What the gateway needs of a device: its session, and its name for the timeline. */
export type GatewayDevice = { name: string; session: DeviceSession | null; offline: string };

export type GatewayDeps = {
  device: (id: SavedDeviceId) => GatewayDevice | null;
  /** What a plug feeds, from the links. */
  feeds: (id: SavedDeviceId) => SavedDeviceId | null;
  /** True when every hardware write is refused. */
  isReadOnly: () => boolean;
  /**
   * Where the timeline goes: the server's database, or — for a connection an
   * app holds — a queue that goes up to the server.
   */
  record: (entry: AuditEntry) => void;
  policy?: Partial<GatewayPolicy>;
  /**
   * Where each device's last switch is remembered. The server passes its
   * database, so a restart is not a way around the dwell time; tests keep it
   * in memory.
   */
  memory?: { get(key: string): string | null; set(key: string, value: string): void };
};

type Current = { on: boolean | null; at: string | null; watts: number | null };

export class ActionGateway {
  #deps: GatewayDeps;
  #policy: GatewayPolicy;
  #record: (entry: AuditEntry) => void;
  #memory: NonNullable<GatewayDeps['memory']>;
  /** Serialises `execute`, so "exactly one command" survives concurrent callers. */
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
  #key = (intent: CommandIntent) => `${intent.deviceId}${intent.target ? `:${intent.target}` : ''}`;
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
  execute(intent: CommandIntent): Promise<GatewayResult> {
    const run = this.#gate.then(
      () => this.#execute(intent),
      () => this.#execute(intent)
    );
    this.#gate = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  async #execute(intent: CommandIntent): Promise<GatewayResult> {
    const at = new Date().toISOString();
    const device = this.#deps.device(intent.deviceId);
    const what = `${intent.capability}${intent.target ? ` ${intent.target}` : ''} ${intent.value ? 'on' : 'off'}`;
    const note = (kind: string, summary: string, detail?: unknown) =>
      this.#record({ at: new Date().toISOString(), kind, actor: intent.by, resource: intent.deviceId, summary, detail });
    const refuse = (detail: string): GatewayResult => {
      this.#record({ at, kind: 'command.refused', actor: intent.by, resource: intent.deviceId, summary: `${what} refused: ${detail}`, detail: intent });
      return { outcome: 'refused', detail };
    };

    // 1. A device that is here, and can do this.
    if (!device) return refuse('No such device');
    const spec = (CAPABILITIES[intent.capability]?.commands as Record<string, { safety: string }> | undefined)?.[intent.command];
    if (!spec) return refuse(`${intent.capability} has no command "${intent.command}"`);
    const session = device.session;
    if (!session) return refuse(device.offline);
    const current = this.#read(session, intent);
    if (!current) return refuse(`It cannot ${intent.capability === 'outlets' ? 'switch that outlet' : `do ${intent.capability}`} right now`);

    // 2. Policy, evaluated now rather than when anything was configured.
    if (this.#deps.isReadOnly()) return refuse('The server is in read-only mode');

    const key = this.#key(intent);
    const dwell = intent.actor === 'automation' ? this.#policy.automationDwellMs : this.#policy.userDwellMs;
    const sinceLast = Date.now() - this.#lastSwitchAt(key);
    if (this.#lastSwitchAt(key) > 0 && sinceLast < dwell) {
      return refuse(`Too soon: ${Math.ceil((dwell - sinceLast) / 1000)} s of the dwell time remains`);
    }

    // 3. Freshness: acting on stale readings is how mains is cut at exactly the wrong moment.
    if (current.on === null || current.at === null) return refuse('Its current state is not known, so it is not switched blind');
    if (this.#ageOf(current.at) > this.#policy.maxDataAgeMs) return refuse('Its reading is stale: refusing to switch blind');

    const fed = intent.capability === 'switch' ? this.#deps.feeds(intent.deviceId) : null;
    const station = fed ? this.#station(fed) : null;
    if (fed) {
      if (!station) return refuse('The station this plug feeds is not answering: refusing to switch without its own reading of mains');
      if (!station.connected || station.at === null || station.present === null) {
        return refuse('The station this plug feeds is not answering: refusing to switch without its own reading of mains');
      }
      if (this.#ageOf(station.at) > this.#policy.maxDataAgeMs) return refuse('The station’s reading is stale: refusing to switch blind');
    }

    // 4. A deliberate act where one matters: turning off what feeds a station or
    //    carries a load, and the first switch of a feeding plug.
    const critical = fed !== null || (current.watts ?? 0) > this.#policy.loadWatts;
    const needsConfirmation =
      intent.actor === 'user' &&
      (spec.safety === 'confirm' || (spec.safety === 'confirm-off-when-critical' && ((!intent.value && critical) || (fed !== null && !this.#everSwitched(key)))));
    if (needsConfirmation && intent.confirmation !== CONFIRMATION) {
      const fedName = fed ? (this.#deps.device(fed)?.name ?? 'the station it feeds') : null;
      const why =
        fedName && !this.#everSwitched(key)
          ? `This plug feeds ${fedName} and has never been switched from here: confirm it is the right plug`
          : fedName
            ? `This cuts mains to ${fedName}`
            : (current.watts ?? 0) > this.#policy.loadWatts
              ? `It is carrying ${Math.round(current.watts!)} W`
              : 'This needs confirming';
      return { ...refuse(`This action needs explicit confirmation. ${why}.`), needsConfirmation: true };
    }

    if (current.on === intent.value) {
      const stationAgreed = station ? station.present === intent.value : undefined;
      return {
        outcome: stationAgreed === false ? 'unverified' : 'verified',
        detail:
          stationAgreed === false
            ? `It is already ${intent.value ? 'on' : 'off'}, but the station it feeds does not agree`
            : `Already ${intent.value ? 'on' : 'off'}`,
        deviceAgreed: true,
        stationAgreed,
      };
    }

    // 5. The intent, before anything physical happens.
    note('command.intent', `${device.name}: ${what} requested: ${intent.reason}`, {
      capability: intent.capability,
      target: intent.target,
      value: intent.value,
      before: current,
      station: station ? { deviceId: fed, present: station.present } : undefined,
    });

    // 6. Exactly one command.
    this.#switched(key, Date.now());
    const switchedAt = Date.now();
    const result = await this.#send(session, intent);
    if (!result.accepted) {
      note('command.failed', `${device.name}: ${what} failed: ${result.error}`);
      return { outcome: 'failed', detail: result.error };
    }

    // 7. The proofs, recorded separately.
    const deviceAgreed = await this.#eventually(() => {
      const now = this.#read(session, intent);
      return now?.on === intent.value;
    });
    const stationAgreed = fed
      ? await this.#eventually(() => {
          const reading = this.#station(fed);
          const readAt = reading?.at ? Date.parse(reading.at) : Number.NaN;
          // Only a reading taken after the switch counts. The one cached from
          // before says what mains was — which, cutting mains to a station that
          // had already lost it, looked exactly like agreement.
          return Boolean(reading?.connected && readAt > switchedAt && reading.present === intent.value);
        })
      : undefined;

    const outcome: GatewayOutcome = deviceAgreed && stationAgreed !== false ? 'verified' : 'unverified';
    const detail = !deviceAgreed
      ? 'It accepted the command but does not report the new state'
      : stationAgreed === false
        ? `It says ${intent.value ? 'on' : 'off'}, but the station it feeds has not seen mains ${intent.value ? 'return' : 'go'}`
        : fed
          ? `Mains ${intent.value ? 'restored' : 'removed'}, confirmed by the plug and the station`
          : `Switched ${intent.value ? 'on' : 'off'}, confirmed by the device`;

    // 8. The outcome, with every piece of evidence.
    note(`command.${outcome}`, `${device.name}: ${detail}`, { deviceAgreed, stationAgreed });
    return { outcome, detail, deviceAgreed, stationAgreed };
  }

  /** What the part being switched reads now. Null when it cannot be switched. */
  #read(session: DeviceSession, intent: CommandIntent): Current | null {
    if (intent.capability === 'switch') {
      const impl = session.capability('switch') as SwitchCapability | null;
      if (!impl) return null;
      const state = impl.state();
      const meter = session.capability('powerMeter')?.read() ?? null;
      return { on: state?.on ?? null, at: state?.at ?? null, watts: meter?.watts ?? null };
    }
    if (intent.capability === 'outlets') {
      const impl = session.capability('outlets') as OutletsCapability | null;
      if (!impl || !intent.target) return null;
      const reading = impl.read();
      const outlet = reading?.outlets.find((candidate) => candidate.id === intent.target);
      if (reading && !outlet) return null;
      return { on: outlet?.on ?? null, at: reading?.at ?? null, watts: outlet?.watts ?? null };
    }
    return null;
  }

  #send(session: DeviceSession, intent: CommandIntent) {
    if (intent.capability === 'switch') return (session.capability('switch') as SwitchCapability).set(intent.value);
    return (session.capability('outlets') as OutletsCapability).set(intent.target!, intent.value);
  }

  /** What a station says about its AC input, from its own session. */
  #station(id: SavedDeviceId): { connected: boolean; present: boolean | null; at: string | null } | null {
    const target = this.#deps.device(id);
    const session = target?.session;
    if (!session) return null;
    const acInput = session.capability('acInput') as AcInputCapability | null;
    if (!acInput) return null;
    const reading = acInput.read();
    return { connected: session.health().status === 'connected', present: reading?.present ?? null, at: reading?.at ?? null };
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

  #ageOf(iso: string | null): number {
    if (iso === null) return Number.POSITIVE_INFINITY;
    const at = new Date(iso).getTime();
    return Number.isFinite(at) ? Date.now() - at : Number.POSITIVE_INFINITY;
  }
}
