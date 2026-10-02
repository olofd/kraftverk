import type { CheckOutcome, ConfigValues, DeviceTypeListing, DraftView, Holder, KraftverkApi, SaveInput, SetupActionResult, SightingView } from '@kraftverk/api-contract';
import { CATEGORIES } from '@kraftverk/device-sdk';

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

  /**
   * Whether a step is passed over: finding the device on the network, when
   * an earlier step already found it — both ways. The last step never is.
   */
  skips(index: number): boolean {
    return this.plan[index]?.kind === 'choose' && this.address !== null && index < this.plan.length - 1;
  }
  /** The step after this one: the next not passed over. */
  after(index: number): number {
    const to = Math.min(index + 1, this.plan.length - 1);
    return this.skips(to) ? to + 1 : to;
  }
  /** The step before this one: past one passed over going forward, as the progress bar shows them. */
  before(index: number): number {
    const to = index - 1;
    return this.skips(to) && to > 0 ? to - 1 : to;
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

/**
 * Whether what the check found lets the add flow go on to saving: a new
 * device, a removed one to bring back, the very device a way is being added
 * to, or one that did not answer when saving anyway is offered.
 */
export function mayContinue(outcome: CheckOutcome, attachingTo: string | null): boolean {
  return (
    outcome.outcome === 'new' ||
    outcome.outcome === 'removed' ||
    (outcome.outcome === 'yours' && attachingTo !== null && outcome.device.id === attachingTo) ||
    (outcome.outcome === 'no-answer' && Boolean(outcome.saveAnyway))
  );
}

/** Whether a type answers to what was typed: every word somewhere in its name, brand, models, description or category. */
export function typeMatches(type: DeviceTypeListing, query: string): boolean {
  const text = [type.meta.name, type.meta.brand, ...(type.meta.models ?? []), type.meta.description, (CATEGORIES as Record<string, { label: string }>)[type.meta.category]?.label]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => text.includes(word));
}
