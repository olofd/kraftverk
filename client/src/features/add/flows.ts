import type { KraftverkApi } from '@kraftverk/api-contract';
import {
  type CheckOutcome,
  type ConfigValues,
  type DraftView,
  type SaveInput,
  type SetupActionResult,
  type SetupStepView,
  type SightingView,
} from '@kraftverk/api-client';
import {
  findStep,
  isSecretField,
  isSimulated,
  openChannel,
  setupPlan,
  type Channel,
  type ConnectionMethod,
  type DeviceType,
  type Identified,
  type OpenConnection,
  type Protocol,
  type Sighting,
} from '@kraftverk/device-sdk';

import { PLATFORM } from '../../runtime/registry';
import type { AppRuntime } from '../../runtime/runtime';

/**
 * One setup, part-way through (docs/DATA-MODEL.md §1, steps 4–7).
 *
 * Every step that touches the device runs where the connection will be held:
 * in the home — a server, or the app's own — for a connection it will hold,
 * and in this app for one it holds for a server. The screens do not care
 * which: they walk the same plan, and ask this.
 */
export interface SetupFlow {
  readonly holder: 'home' | 'this-app';
  readonly plan: SetupStepView[];
  readonly address: string | null;
  readonly device: Record<string, unknown>;
  readonly connection: Record<string, unknown>;
  /** Secret fields held so far, by name — never their values. */
  readonly secrets: string[];
  /** What the transport can see, for a `list` choose step. */
  sightings(): Promise<SightingView[]>;
  /** The platform's own chooser, for a `chooser` choose step. Call it straight from a tap. */
  chooser(showAll?: boolean): Promise<SightingView | null>;
  choose(choice: { address: string } | { manual: string }): Promise<void>;
  update(values: { device?: ConfigValues; connection?: ConfigValues }): Promise<void>;
  action(stepId: string, actionId: string, input?: ConfigValues): Promise<SetupActionResult>;
  discover(stepId: string): Promise<SetupActionResult>;
  check(): Promise<CheckOutcome>;
  /** Saves, and returns the device's id. */
  save(input: SaveInput): Promise<string>;
  discard(): void;
}

/**
 * A connection the home will hold — a server's, or the app's own: every step
 * runs there, in a draft only its starter sees, through the one interface.
 */
export class HomeFlow implements SetupFlow {
  readonly holder = 'home' as const;
  #draft: DraftView;

  private constructor(
    private api: KraftverkApi,
    draft: DraftView
  ) {
    this.#draft = draft;
  }

  static async start(api: KraftverkApi, typeId: string, methodId: string): Promise<HomeFlow> {
    return new HomeFlow(api, await api.setup.start({ typeId, methodId }));
  }

  get plan() {
    return this.#draft.plan;
  }
  get address() {
    return this.#draft.address;
  }
  get device() {
    return this.#draft.device;
  }
  get connection() {
    return this.#draft.connection;
  }
  get secrets() {
    return this.#draft.secrets;
  }

  sightings() {
    return this.api.setup.sightings(this.#draft.id);
  }
  /** The platform's chooser, run by the home — for a browser's own, on this page: called straight from a tap. */
  async chooser(showAll = false): Promise<SightingView | null> {
    this.#draft = await this.api.setup.choose(this.#draft.id, { chooser: { showAll } });
    const address = this.#draft.address;
    if (!address) return null;
    const seen = (await this.api.setup.sightings(this.#draft.id)).find((sighting) => sighting.address === address);
    return seen ?? { address, name: 'The device you chose', detail: null, identity: null, seenAt: new Date().toISOString(), rssi: null, claimedBy: null };
  }
  async choose(choice: { address: string } | { manual: string }) {
    this.#draft = await this.api.setup.choose(this.#draft.id, choice);
  }
  async update(values: { device?: ConfigValues; connection?: ConfigValues }) {
    this.#draft = await this.api.setup.update(this.#draft.id, values);
  }
  async action(stepId: string, actionId: string, input: ConfigValues = {}) {
    const result = await this.api.setup.action(this.#draft.id, stepId, actionId, input);
    this.#draft = await this.api.setup.get(this.#draft.id);
    return result;
  }
  async discover(stepId: string) {
    const result = await this.api.setup.discover(this.#draft.id, stepId);
    this.#draft = await this.api.setup.get(this.#draft.id);
    return result;
  }
  async check() {
    const outcome = await this.api.setup.check(this.#draft.id);
    this.#draft = { ...this.#draft, checked: outcome };
    return outcome;
  }
  async save(input: SaveInput) {
    return (await this.api.setup.save(this.#draft.id, input)).id;
  }
  discard() {
    void this.api.setup.discard(this.#draft.id).catch(() => undefined);
  }
}

const CHECK_TIMEOUT_MS = 20_000;

/**
 * A connection this app will hold for a server: every step runs here, over
 * this app's own radio, with the same device-type and protocol code. What it
 * learns — never a secret — goes to the server to be judged against your
 * devices. A home of the app's own holds its connections itself: `HomeFlow`.
 * This goes with the app's runtime, when the hub's `createHolding` holds
 * them (docs/PLAN-SHARED-CORE.md, 6f).
 */
export class AppFlow implements SetupFlow {
  readonly holder = 'this-app' as const;
  readonly plan: SetupStepView[];
  address: string | null = null;
  device: Record<string, unknown> = {};
  connection: Record<string, unknown> = {};
  #secrets = new Map<string, string>();
  #sighting: Sighting | null = null;
  #draftId: string | null = null;
  #stopWatching: (() => void) | null = null;
  #seen: readonly Sighting[] = [];

  /** Simulated: nothing to reach, so no protocol and no transport — only the type's own steps, then its simulator, held here. */
  readonly #simulated: boolean;

  constructor(
    private api: KraftverkApi,
    private runtime: AppRuntime,
    private type: DeviceType<any>,
    private method: ConnectionMethod,
    private protocol: Protocol | null
  ) {
    this.#simulated = isSimulated(method);
    this.plan = setupPlan({ type, method, protocol, transport: this.#simulated ? null : runtime.registry.definition(method.transport), platform: PLATFORM });
    this.address = method.address ?? null;
  }

  get secrets() {
    return [...this.#secrets.keys()];
  }

  #binding() {
    const binding = this.protocol?.bindings[this.method.transport];
    if (!binding) throw new Error(`This app cannot reach a ${this.type.meta.name} by ${this.method.label}: update it`);
    return binding;
  }

  #view(sighting: Sighting): SightingView | null {
    const recognised = this.#binding().recognise(sighting);
    if (!recognised) return null;
    return { address: sighting.address, name: recognised.name, detail: recognised.detail ?? null, identity: recognised.identity ?? null, seenAt: sighting.seenAt, rssi: sighting.rssi ?? null, claimedBy: null };
  }

  async sightings(): Promise<SightingView[]> {
    const transport = await this.runtime.registry.start(this.method.transport);
    if (transport?.watch && !this.#stopWatching) {
      this.#stopWatching = transport.watch(this.#binding().filter ?? {}, (sightings) => {
        this.#seen = sightings;
      });
    }
    return this.#seen.flatMap((sighting) => this.#view(sighting) ?? []);
  }

  async chooser(showAll = false): Promise<SightingView | null> {
    const transport = await this.runtime.registry.start(this.method.transport);
    if (!transport?.choose) throw new Error('This app has no chooser for that');
    const sighting = await transport.choose(showAll ? {} : (this.#binding().filter ?? {}));
    if (!sighting) return null;
    const view = this.#view(sighting) ?? { address: sighting.address, name: sighting.name ?? 'Unknown device', detail: null, identity: null, seenAt: sighting.seenAt, rssi: null, claimedBy: null };
    this.#sighting = sighting;
    this.#seen = [...this.#seen.filter((seen) => seen.address !== sighting.address), sighting];
    return view;
  }

  async choose(choice: { address: string } | { manual: string }) {
    if ('manual' in choice) {
      const address = this.#binding().parseAddress?.(choice.manual) ?? null;
      if (!address) throw new Error(`That is not a ${this.#binding().addressLabel ?? 'valid address'}`);
      this.address = address;
      return;
    }
    const sighting = this.#seen.find((seen) => seen.address === choice.address) ?? this.#sighting;
    if (!sighting) throw new Error('That device is not in the list any more; choose again');
    this.address = sighting.address;
    this.connection = { ...this.connection, ...(this.#binding().recognise(sighting)?.config ?? {}) };
  }

  async update(values: { device?: ConfigValues; connection?: ConfigValues }) {
    const schema = { ...(this.protocol?.credentials?.schema.fields ?? {}), ...(this.method.config?.fields ?? {}) };
    if (values.device) this.device = { ...this.device, ...values.device };
    for (const [field, value] of Object.entries(values.connection ?? {})) {
      const spec = schema[field];
      if (spec && isSecretField(spec)) {
        if (typeof value === 'string' && value) this.#secrets.set(field, value);
      } else this.connection[field] = value;
    }
  }

  #context(signal: AbortSignal) {
    return {
      draft: this.device as ConfigValues,
      connection: this.connection as ConfigValues,
      address: this.address,
      secrets: { get: (field: string) => this.#secrets.get(field) ?? null },
      http: (url: string, init: RequestInit & { timeoutMs?: number } = {}) => fetch(url, { ...init, signal: AbortSignal.timeout(init.timeoutMs ?? 15_000) }),
      // This app finds a device through the platform's chooser, one at a time: there is no list to match against.
      sightings: [],
      log: { info: () => {}, warn: (message: string) => console.warn(`[setup] ${message}`), error: (message: string) => console.error(`[setup] ${message}`) },
      signal,
      platform: PLATFORM,
    };
  }

  async action(stepId: string, actionId: string, input: ConfigValues = {}) {
    const step = findStep(this.type, this.method, this.protocol, stepId);
    const action = step && step.kind === 'form' ? step.actions?.find((candidate) => candidate.id === actionId) : undefined;
    if (!action) throw new Error('No such action');
    const result = await action.run(this.#context(AbortSignal.timeout(90_000)), input);
    if (result.suggestedConfig) await this.update(step!.kind === 'form' && step!.target === 'device' ? { device: result.suggestedConfig } : { connection: result.suggestedConfig });
    return result;
  }

  async discover(stepId: string) {
    const step = findStep(this.type, this.method, this.protocol, stepId);
    if (!step || step.kind !== 'discover') throw new Error('No such step');
    const result = await step.run(this.#context(AbortSignal.timeout(90_000)));
    if (result.suggestedConfig) await this.update(step.target === 'device' ? { device: result.suggestedConfig } : { connection: result.suggestedConfig });
    return result;
  }

  /** Reads the device once, over this app's own radio, then lets it go. */
  async #identify(): Promise<{ identified: Identified | null; failure?: string }> {
    let channel: Channel | null = null;
    try {
      channel = await openChannel(this.runtime.registry, this.protocol, { transport: this.method.transport, address: this.address! });
      // A channel connects in the background; the device gets a moment to answer.
      const opened = channel;
      if (!opened.connected) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            stop();
            reject(new Error(`Could not connect to it: ${String(opened.describe?.().lastError ?? 'it did not answer')}`));
          }, CHECK_TIMEOUT_MS);
          const stop = opened.onConnectedChange((connected) => {
            if (!connected) return;
            clearTimeout(timer);
            stop();
            resolve();
          });
        });
      }
      const connection: OpenConnection = {
        method: this.method.id,
        protocol: this.method.protocol,
        transport: this.method.transport,
        address: this.address!,
        channel: opened,
        config: this.connection as ConfigValues,
        secrets: { get: (field) => this.#secrets.get(field) ?? null },
        platform: PLATFORM,
      };
      const identified = await this.type.identify(connection, {
        config: this.device as ConfigValues,
        log: { info: () => {}, warn: () => {}, error: () => {} },
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      });
      this.device = { ...this.device, ...(identified.config ?? {}) };
      return { identified };
    } catch (error) {
      return { identified: null, failure: (error as Error).message };
    } finally {
      await channel?.close().catch(() => undefined);
    }
  }

  async check(): Promise<CheckOutcome> {
    if (!this.address) throw new Error('Choose the device first');
    if (this.#simulated) throw new Error('With a server, the server holds a simulated device: add it through your server');
    const { identified, failure } = await this.#identify();
    if (!this.runtime.clientId) await this.runtime.register();
    const draft = await this.api.setup.startHeld({
      clientId: this.runtime.clientId!,
      typeId: this.type.id,
      methodId: this.method.id,
      address: this.address,
      identified: identified ? { identity: identified.identity, model: identified.model, name: identified.name, summary: identified.summary, config: identified.config } : null,
      failure,
      device: this.device as ConfigValues,
      connection: this.connection as ConfigValues,
    });
    this.#draftId = draft.id;
    return draft.checked!;
  }

  async save(input: SaveInput): Promise<string> {
    if (!this.#draftId) throw new Error('Check that it answers first');
    const saved = await this.api.setup.save(this.#draftId, input);
    // The connection's secrets stay in this app, with the connection it holds.
    const held = saved.connections.find(
      (connection) => connection.heldBy.kind === 'client' && connection.heldBy.id === this.runtime.clientId && connection.method === this.method.id
    );
    if (held && this.#secrets.size) this.runtime.setHeldSecrets(held.id, Object.fromEntries(this.#secrets));
    return saved.id;
  }

  discard() {
    this.#stopWatching?.();
    this.#stopWatching = null;
  }
}
