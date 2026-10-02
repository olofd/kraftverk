import type { Holder, KraftverkApi } from '@kraftverk/api-contract';
import type { CheckOutcome, ConfigValues, DraftView, SaveInput, SetupActionResult, SetupStepView, SightingView } from '@kraftverk/api-client';

/**
 * One setup, part-way through (docs/DATA-MODEL.md §1, steps 4–7).
 *
 * Every step that touches the device runs where the connection will be held:
 * the home — a server, or the app's own — or this app, for a way it holds
 * for a server. The home sends each step there; the screens walk the same
 * plan either way, and ask this.
 */
export interface SetupFlow {
  readonly holder: Holder;
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
 * One way being set up, through the one interface, in a draft only its
 * starter sees: held by the home, or by this app for a server — the home
 * runs each step where it will be held.
 */
export class HomeFlow implements SetupFlow {
  #draft: DraftView;

  private constructor(
    private api: KraftverkApi,
    readonly holder: Holder,
    draft: DraftView
  ) {
    this.#draft = draft;
  }

  static async start(api: KraftverkApi, typeId: string, methodId: string, holder: Holder): Promise<HomeFlow> {
    return new HomeFlow(api, holder, await api.setup.start({ typeId, methodId, holder }));
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
