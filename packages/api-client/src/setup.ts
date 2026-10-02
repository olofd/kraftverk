import type { CheckOutcome, ConfigValues, DraftView, Holder, KraftverkApi, SaveInput, SetupActionResult, SightingView } from '@kraftverk/api-contract';

/**
 * One way being set up (docs/DATA-MODEL.md §1, steps 4–7), as the add
 * screens walk it: through the one interface, in a draft only its starter
 * sees. Every step that touches the device runs on the node that will hold
 * it — the master, or this node for a way it holds for the master — and the
 * home sends it there; the screens walk the same plan either way.
 */
export class SetupFlow {
  #draft: DraftView;

  private constructor(
    private readonly api: KraftverkApi,
    readonly holder: Holder,
    draft: DraftView
  ) {
    this.#draft = draft;
  }

  static async start(api: KraftverkApi, typeId: string, methodId: string, holder: Holder): Promise<SetupFlow> {
    return new SetupFlow(api, holder, await api.setup.start({ typeId, methodId, holder }));
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
  /** Secret fields held so far, by name — never their values. */
  get secrets() {
    return this.#draft.secrets;
  }

  /** What the transport can see, for a `list` choose step. */
  sightings(): Promise<SightingView[]> {
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
  async choose(choice: { address: string } | { manual: string }): Promise<void> {
    this.#draft = await this.api.setup.choose(this.#draft.id, choice);
  }
  async update(values: { device?: ConfigValues; connection?: ConfigValues }): Promise<void> {
    this.#draft = await this.api.setup.update(this.#draft.id, values);
  }
  async action(stepId: string, actionId: string, input: ConfigValues = {}): Promise<SetupActionResult> {
    const result = await this.api.setup.action(this.#draft.id, stepId, actionId, input);
    this.#draft = await this.api.setup.get(this.#draft.id);
    return result;
  }
  async discover(stepId: string): Promise<SetupActionResult> {
    const result = await this.api.setup.discover(this.#draft.id, stepId);
    this.#draft = await this.api.setup.get(this.#draft.id);
    return result;
  }
  async check(): Promise<CheckOutcome> {
    const outcome = await this.api.setup.check(this.#draft.id);
    this.#draft = { ...this.#draft, checked: outcome };
    return outcome;
  }
  /** Saves, and returns the device's id. */
  async save(input: SaveInput): Promise<string> {
    return (await this.api.setup.save(this.#draft.id, input)).id;
  }
  discard(): void {
    void this.api.setup.discard(this.#draft.id).catch(() => undefined);
  }
}
