import { ApiError, type CheckOutcome, type DraftView, type HeldSetupInput, type SightingView } from '@kraftverk/api-contract';
import {
  transportOf,
  isBridgedMethod,
  nodeId,
  savedDeviceId,
  findStep,
  isSecretField,
  isSimulated,
  methodOf,
  randomHex,
  setupPlan,
  type AuditRecord,
  type ConfigValues,
  type Identified,
  type NodeId,
  type NodeTraits,
  type SavedDeviceId,
  type ScopedHttp,
  type SetupActionResult,
  type SetupChoice,
} from '@kraftverk/device-sdk';
import { judgeCheck, withTimeout, type SessionManager } from '@kraftverk/holder';
import type { ConnectionStore, DeviceCatalog, DeviceRecord, LinkStore, SqlDatabase } from '@kraftverk/store';

import type { ProtocolRegistry } from '../installed/protocols.ts';
import { unfitFor } from '../installed/needs.ts';
import { platformWords, type TransportHost } from '../installed/transports.ts';
import type { DeviceTypeRegistry } from '../installed/types.ts';
import { unref } from '../timers.ts';
import { connectionSchema } from '../installed/connection-schema.ts';
import { DRAFT_TTL_MS, viewOf, type Draft, type SaveRequest } from './draft.ts';
import { membersOnOffer, openBridges, type MemberOffer } from '../devices/members.ts';
import { overHardware, SIMULATED_REACH, throughBridge } from './reach.ts';
import { keepSecrets, saveable, writeSaved } from './save.ts';

export type { SaveRequest } from './draft.ts';

/**
 * Adding a device to a home (docs/DATA-MODEL.md §1).
 *
 * A **draft** is one person part-way through setting up one device the home
 * will hold (`draft.ts`) — the server's, or an app's with no server. Choosing a category and a type is the app's; from
 * the connection method on, every step that touches the device runs here —
 * listing what the transport can see, fetching a key, reading the device once
 * — because this is where the connection will be held. How a draft reaches
 * the device, or reaches nothing because it is simulated, is its `reach`
 * (`reach.ts`); saving is `save.ts`.
 *
 * Secrets a step finds stay here. The app is handed a placeholder in their
 * place, which saving turns back into the secret (see SECURITY.md).
 */

const ACTION_TIMEOUT_MS = 90_000;
const PLACEHOLDER = /^held:[0-9a-f]{16}$/;

export type SetupServiceDeps = {
  /** Where the home is kept: a save is one transaction. */
  db: SqlDatabase;
  /** Where the timeline goes. */
  record: (entry: AuditRecord) => void;
  types: DeviceTypeRegistry;
  protocols: ProtocolRegistry;
  transports: TransportHost;
  catalog: DeviceCatalog;
  connections: ConnectionStore;
  links: LinkStore;
  sessions: SessionManager;
  /** For helpers that call a vendor's API once — fetching a key. */
  http: ScopedHttp;
  /** This node: what holds a way the home sets up for itself. */
  self: NodeId;
  /** What a node of the home declares it is, by its id: what a way needs of the node holding it is judged against it. */
  traits: (node: NodeId) => NodeTraits | null;
};

export class SetupService {
  #drafts = new Map<string, Draft>();

  /** What a node declares it is; one the home does not know is taken as nothing. */
  #traits(node: NodeId): NodeTraits {
    return this.deps.traits(node) ?? { alwaysOn: false, reachable: false, trusted: false };
  }
  /** Forgets drafts past their time, each minute — only while there are drafts: made, nothing runs. */
  #sweeper: ReturnType<typeof setInterval> | null = null;

  constructor(private deps: SetupServiceDeps) {}

  stop(): void {
    for (const id of [...this.#drafts.keys()]) this.discard(id);
  }

  #sweepWhileNeeded(): void {
    if (this.#drafts.size && !this.#sweeper) {
      this.#sweeper = setInterval(() => this.#sweep(), 60_000);
      unref(this.#sweeper);
    } else if (!this.#drafts.size && this.#sweeper) {
      clearInterval(this.#sweeper);
      this.#sweeper = null;
    }
  }

  /**
   * Begins setting up a device of `typeId`, over `methodId`, held by this
   * home. Refused when the method's transport cannot be used here, saying why.
   */
  async start(input: { typeId: string; methodId?: string | null; by: string; through?: string }): Promise<DraftView> {
    const type = this.deps.types.get(input.typeId);
    if (!type) throw new ApiError('not-found', `Nothing installed here knows what "${input.typeId}" is`);

    const method = input.methodId ? methodOf(type, input.methodId) : type.connections.length === 1 ? type.connections[0]! : null;
    if (!method) throw new ApiError('invalid', input.methodId ? `${type.meta.name} has no way called "${input.methodId}"` : 'Choose how to connect first');

    // Simulated: nothing to reach, so no protocol and no transport — only the type's own steps, then its simulator.
    let reach = SIMULATED_REACH;
    let transport = null;
    let through: SavedDeviceId | null = null;
    const unfit = unfitFor(method, this.#traits(this.deps.self));
    if (unfit) throw new ApiError('conflict', `${method.label}: ${unfit}`);
    if (isBridgedMethod(method)) {
      // Through a bridge: one open here hands it its link, and its members are what is found.
      const bridges = openBridges(this.deps, method.through).filter((bridge) => !input.through || bridge.id === input.through);
      if (!bridges.length) {
        const which = method.through.map((id) => this.deps.types.get(id)?.meta.name ?? id).join(' or ');
        throw new ApiError('conflict', `A ${type.meta.name} is reached through ${which}: add that first, or open it here`);
      }
      through = bridges.length === 1 ? bridges[0]!.id : null;
      reach = throughBridge((id) => this.deps.sessions.get(id)?.bridge ?? null, this.deps.transports.platform);
    } else if (!isSimulated(method)) {
      const protocol = this.deps.protocols.get(method.protocol);
      if (!protocol?.bindings[method.transport]) throw new ApiError('conflict', `${platformWords(this.deps.transports.platform).this} cannot reach a ${type.meta.name} by ${method.label}: it needs updating`);
      transport = await this.deps.transports.start(method.transport);
      const available = this.deps.transports.available(method.transport);
      if (!transport || !available.ok) throw new ApiError('conflict', available.ok ? `${method.label} cannot be used here` : available.reason);
      reach = overHardware(protocol, this.deps.transports.definition(method.transport), this.deps.transports);
    }

    const draft = this.#newDraft({
      by: input.by,
      heldBy: this.deps.self,
      type,
      method,
      reach,
      plan: setupPlan({ type, method, protocol: reach.protocol, transport: reach.transport, platform: this.deps.transports.platform, values: transport?.values?.() ?? {} }),
      address: method.address ?? null,
      through,
    });

    // What the transport can see, kept current for as long as the draft lives.
    const binding = method.transport ? reach.protocol?.bindings[method.transport] : undefined;
    if (binding && transport?.watch && !method.address && reach.transport?.discovery[this.deps.transports.platform] === 'list') {
      draft.stopWatching = transport.watch(binding.filter ?? {}, (sightings) => {
        draft.sightings = sightings;
      });
    }
    return viewOf(draft);
  }

  /**
   * A connection the app will hold (docs/DATA-MODEL.md §1, "held by this
   * phone"). The app ran every step itself — found the device with its own
   * radio, read it with the type's `identify` — and sends what it learnt. The
   * server decides what that means against the devices you have, exactly as
   * for its own check, and saves the connection held by that app. Its secrets
   * never come here: they stay in the app.
   */
  startHeld(input: HeldSetupInput & { by: string }): DraftView {
    const type = this.deps.types.get(input.typeId);
    if (!type) throw new ApiError('not-found', `Nothing installed here knows what "${input.typeId}" is`);
    const method = type.connections.find((candidate) => candidate.id === input.methodId);
    if (!method) throw new ApiError('invalid', `${type.meta.name} has no way called "${input.methodId}"`);
    const unfit = unfitFor(method, this.#traits(nodeId(input.nodeId)));
    if (unfit) throw new ApiError('invalid', `${method.label}: ${unfit}`);
    const protocol = this.deps.protocols.get(method.protocol) ?? null;
    const secret = new Set(
      Object.entries(connectionSchema(method, protocol).fields)
        .filter(([, spec]) => isSecretField(spec))
        .map(([field]) => field)
    );
    const draft = this.#newDraft({
      by: input.by,
      heldBy: nodeId(input.nodeId),
      type,
      method,
      reach: overHardware(protocol, this.deps.transports.definition(method.transport), this.deps.transports),
      plan: [],
      address: input.address,
      // A member it holds through a bridge it holds: the way goes through that bridge.
      through: input.through ? savedDeviceId(input.through) : null,
    });
    draft.device = { ...(input.device ?? {}) };
    draft.connection = Object.fromEntries(Object.entries(input.connection ?? {}).filter(([field]) => !secret.has(field)));
    if (input.identified) this.#judge(draft, input.identified);
    else this.#checked(draft, { outcome: 'no-answer', summary: input.failure ?? 'It did not answer.', saveAnyway: type.setup?.saveAnyway ?? null });
    return viewOf(draft);
  }

  view(id: string): DraftView {
    return viewOf(this.#draft(id));
  }

  /** Refuses a draft to anyone but the account that started it: it may hold a key. */
  assertOwner(id: string, by: string): void {
    if (this.#draft(id).by !== by) throw new ApiError('not-found', 'That setup has expired; start again');
  }

  discard(id: string): void {
    const draft = this.#drafts.get(id);
    draft?.stopWatching?.();
    this.#drafts.delete(id);
    this.#sweepWhileNeeded();
  }

  /** What the transport sees that this device's protocol recognises — or, through a bridge, its members — each marked when it is already yours. */
  sightings(id: string): SightingView[] {
    const draft = this.#draft(id);
    if (draft.method && isBridgedMethod(draft.method)) {
      const now = new Date().toISOString();
      return this.#members(draft).map(({ bridge, member, claimedBy }) => ({
        address: member.key,
        name: member.name ?? member.key,
        detail: [member.model, `through ${bridge.name}`].filter(Boolean).join(' · '),
        identity: member.identity,
        seenAt: now,
        rssi: null,
        claimedBy,
        through: { id: bridge.id, name: bridge.name },
      }));
    }
    const way = draft.method!;
    const binding = way.transport ? draft.reach.protocol?.bindings[way.transport] : undefined;
    if (!binding || !way.transport) return [];
    const transport = way.transport;
    return draft.sightings.flatMap((sighting): SightingView[] => {
      const recognised = binding.recognise(sighting);
      if (!recognised) return [];
      const claim = draft.reach.exclusive ? this.deps.connections.claimant(transport, sighting.address) : null;
      const claimed = claim ? this.deps.catalog.get(claim.deviceId) : null;
      return [
        {
          address: sighting.address,
          name: recognised.name,
          detail: recognised.detail ?? null,
          identity: recognised.identity ?? null,
          seenAt: sighting.seenAt,
          rssi: sighting.rssi ?? null,
          claimedBy: claimed ? { id: claimed.id, name: claimed.name } : null,
          through: null,
        },
      ];
    });
  }

  /**
   * The physical device: one the transport saw, an address typed by hand,
   * or one picked in the platform's own chooser — a browser's Bluetooth
   * picker, which shows only after a person's tap, so it is asked straight
   * from one. Dismissed, nothing is chosen.
   */
  async choose(id: string, input: { address?: string; through?: string; manual?: string; chooser?: { showAll?: boolean } }): Promise<DraftView> {
    const draft = this.#draft(id);
    if (draft.method && isBridgedMethod(draft.method)) {
      // A member, from its bridge's own list: never typed, never picked in a chooser.
      const offer = input.address === undefined ? null : (this.#members(draft).find(({ bridge, member }) => member.key === input.address && (!input.through || bridge.id === input.through)) ?? null);
      if (!offer) throw new ApiError('invalid', 'That device is not behind it any more; choose again');
      draft.address = offer.member.key;
      draft.through = offer.bridge.id;
      draft.identityHint = offer.member.identity;
      draft.checked = null;
      this.#touch(draft);
      return viewOf(draft);
    }
    const binding = draft.reach.protocol?.bindings[draft.method!.transport];
    if (!binding) throw new ApiError('invalid', 'This method has nothing to choose');

    if (input.chooser) {
      const transport = await this.deps.transports.start(draft.method!.transport);
      if (!transport?.choose) throw new ApiError('invalid', `${platformWords(this.deps.transports.platform).this} has no chooser for ${draft.method!.label}: choose from the list`);
      // Shown everything, it may be a device its protocol does not know by its advertising alone: the check reads it.
      const sighting = await transport.choose(input.chooser.showAll ? {} : (binding.filter ?? {}));
      if (!sighting) return viewOf(draft);
      draft.sightings = [...draft.sightings.filter((seen) => seen.address !== sighting.address), sighting];
      const recognised = binding.recognise(sighting);
      draft.address = sighting.address;
      draft.identityHint = recognised?.identity ?? null;
      draft.connection = { ...draft.connection, ...(recognised?.config ?? {}) };
    } else if (input.manual !== undefined) {
      const address = binding.parseAddress?.(input.manual) ?? null;
      if (!address) throw new ApiError('invalid', binding.parseAddress ? `That is not a ${binding.addressLabel ?? 'valid address'}` : 'An address cannot be typed for this');
      draft.address = address;
      draft.identityHint = null;
    } else {
      const sighting = draft.sightings.find((candidate) => candidate.address.toLowerCase() === input.address?.toLowerCase());
      const recognised = sighting ? binding.recognise(sighting) : null;
      if (!sighting || !recognised) throw new ApiError('invalid', 'That device is not in the list any more; choose again');
      draft.address = sighting.address;
      draft.identityHint = recognised.identity ?? null;
      // What the sighting already says — a device's id and version — fills in the connection.
      draft.connection = { ...draft.connection, ...(recognised.config ?? {}) };
    }
    draft.checked = null;
    this.#touch(draft);
    return viewOf(draft);
  }

  /** Values entered in a form step, for the device or for its connection. Secrets stay here. */
  update(id: string, input: { device?: ConfigValues; connection?: ConfigValues }): DraftView {
    const draft = this.#draft(id);
    const schema = connectionSchema(draft.method, draft.reach.protocol);
    for (const [field, value] of Object.entries(input.device ?? {})) {
      if (!(field in draft.type.config.fields)) throw new ApiError('invalid', `${draft.type.meta.name} has no setting "${field}"`);
      draft.device[field] = value;
    }
    for (const [field, value] of Object.entries(input.connection ?? {})) {
      const spec = schema.fields[field];
      if (!spec) throw new ApiError('invalid', `This connection has no setting "${field}"`);
      if (!isSecretField(spec)) {
        draft.connection[field] = value;
        continue;
      }
      if (typeof value !== 'string' || !value) continue;
      // A placeholder the app was handed stands for a secret already here — and only one it was handed.
      if (PLACEHOLDER.test(value)) {
        const held = draft.placeholders.get(value);
        if (held === undefined) throw new ApiError('invalid', 'That value has expired; fetch it again');
        draft.secrets.set(field, held);
      } else draft.secrets.set(field, value);
    }
    draft.checked = null;
    this.#touch(draft);
    return viewOf(draft);
  }

  /** Runs a step's helper — "Fetch it with my vendor account" — here, and holds any secret it finds. */
  async action(id: string, stepId: string, actionId: string, input: ConfigValues, signal?: AbortSignal): Promise<SetupActionResult> {
    const draft = this.#draft(id);
    const step = findStep(draft.type, draft.method, draft.reach.protocol, stepId);
    if (!step || step.kind !== 'form') throw new ApiError('not-found', 'No such step');
    const action = step.actions?.find((candidate) => candidate.id === actionId);
    if (!action) throw new ApiError('not-found', 'No such action');
    // What its last turn asked to carry comes back with what the person gave, and only once.
    const carried = draft.carried.get(actionId) ?? {};
    draft.carried.delete(actionId);
    const result = await withTimeout(action.run(this.#setupContext(draft, signal), { ...input, ...carried }), action.label, ACTION_TIMEOUT_MS).catch(
      (error: unknown) => ({ ok: false, detail: (error as Error).message }) as SetupActionResult
    );
    // Kept here for its next turn, never sent: the app sees what to ask, not what was carried.
    if (result.ask?.carry) {
      draft.carried.set(actionId, result.ask.carry);
      return this.#hold(draft, step.target, { ...result, ask: { schema: result.ask.schema } });
    }
    return this.#hold(draft, step.target, result);
  }

  /** A step of the type's own that finds candidates. */
  async discover(id: string, stepId: string, signal?: AbortSignal): Promise<SetupActionResult> {
    const draft = this.#draft(id);
    const step = findStep(draft.type, draft.method, draft.reach.protocol, stepId);
    if (!step || step.kind !== 'discover') throw new ApiError('not-found', 'No such step');
    const result = await withTimeout(step.run(this.#setupContext(draft, signal)), step.title, ACTION_TIMEOUT_MS).catch(
      (error: unknown) => ({ ok: false, detail: (error as Error).message }) as SetupActionResult
    );
    return this.#hold(draft, step.target, result);
  }

  /** Applies a choice a helper offered: its values, secrets as the placeholders the app was given. */
  pick(id: string, target: 'device' | 'connection', choice: SetupChoice): DraftView {
    return this.update(id, target === 'device' ? { device: choice.config } : { connection: choice.config });
  }

  /**
   * Reads the device once: the check step. A device already reached at this
   * address is yours without asking it; any other is asked who it is, and
   * what it says decides the outcome — new, yours, yours before, another model.
   */
  async check(id: string): Promise<CheckOutcome> {
    const draft = this.#draft(id);
    const method = draft.method!;
    if (!draft.address) throw new ApiError('invalid', 'Choose the device first');

    // Set up again: it must answer as the device it is — anything else is not saved over it.
    if (draft.again) {
      const read = await draft.reach.identify(draft);
      if ('outcome' in read) return this.#checked(draft, { ...read.outcome, ...(read.outcome.outcome === 'no-answer' ? { saveAnyway: null } : {}) } as CheckOutcome);
      const said = read.identified.identity;
      if (said && draft.again.identity && said !== draft.again.identity) {
        return this.#checked(draft, { outcome: 'no-answer', summary: `That answered as another device, not ${draft.again.name}: nothing is changed.`, saveAnyway: null });
      }
      return this.#checked(draft, { outcome: 'yours', summary: `${draft.again.name} answered: it is reached this way from now on.`, device: { id: draft.again.deviceId, name: draft.again.name } }, read.identified);
    }

    if (draft.reach.exclusive) {
      const claim = draft.through ? this.deps.connections.member(draft.through, draft.address) : this.deps.connections.claimant(transportOf(method), draft.address);
      const claimed = claim ? this.deps.catalog.active(claim.deviceId) : null;
      if (claimed) return this.#checked(draft, { outcome: 'yours', summary: `This is your ${claimed.name}, already reached this way.`, device: { id: claimed.id, name: claimed.name } });
    }
    const read = await draft.reach.identify(draft);
    return 'outcome' in read ? this.#checked(draft, read.outcome) : this.#judge(draft, read.identified);
  }

  /**
   * Reads the device once and judges nothing: what a node following the
   * master learns itself, for the master to judge against what you have
   * (`startHeld`). With the secrets entered, which stay with whoever holds it.
   */
  async read(id: string): Promise<{ draft: DraftView; read: { identified: Identified } | { outcome: CheckOutcome }; secrets: Record<string, string> }> {
    const draft = this.#draft(id);
    if (!draft.address) throw new ApiError('invalid', 'Choose the device first');
    const read = await draft.reach.identify(draft);
    if ('identified' in read) draft.device = { ...draft.device, ...(read.identified.config ?? {}) };
    this.#touch(draft);
    return { draft: viewOf(draft), read, secrets: Object.fromEntries(draft.secrets) };
  }

  /**
   * Saves: in one go, the device (or the one it turned out to be), its
   * connection, that connection's secrets, and its links. Then its session opens.
   */
  async save(id: string, input: SaveRequest): Promise<DeviceRecord> {
    const draft = this.#draft(id);
    const method = draft.method!;
    if (draft.again) return this.#saveAgain(draft);
    // The node that will hold it was forgotten while it was being set up.
    if (!this.deps.traits(draft.heldBy)) throw new ApiError('not-found', 'The node that was to hold it is no longer part of this home');
    const config = saveable(draft, input, this.deps.self);
    const { record, kind } = this.deps.db.transaction(() => writeSaved(this.deps, draft, input, config))();

    this.deps.record({
      at: new Date().toISOString(),
      kind,
      actor: draft.by,
      resourceKind: 'device',
      resource: record.id,
      summary:
        kind === 'device.added'
          ? `Added "${record.name}" (${draft.type.meta.name}) over ${method.label}`
          : kind === 'device.restored'
            ? `Brought back "${record.name}" with its history, over ${method.label}`
            : `Added ${method.label} as another way to reach "${record.name}"`,
      detail: { typeId: draft.type.id, method: method.id, transport: method.transport, links: input.links ?? [] },
    });

    this.discard(id);
    await this.deps.sessions.sync(this.deps.catalog.list());
    return record;
  }

  /**
   * Sets one of a device's ways up again: its credentials, through the same
   * steps as adding it, then a check that it is the same device. Only a way
   * this node holds itself, over a transport: one through a bridge has
   * nothing of its own to give — its bridge is signed into instead.
   */
  async again(input: { deviceId: string; connectionId: string; by: string }): Promise<DraftView> {
    const device = this.deps.catalog.active(input.deviceId as SavedDeviceId);
    const connection = device ? this.deps.connections.forDevice(device.id).find((each) => each.id === input.connectionId) : undefined;
    if (!device || !connection) throw new ApiError('not-found', 'No such way to reach it');
    if (connection.heldBy !== this.deps.self) throw new ApiError('conflict', 'That way is kept by the node that holds it: set it up again there');
    const type = this.deps.types.get(device.typeId);
    const method = type ? methodOf(type, connection.method) : null;
    if (!type || !method || isBridgedMethod(method) || isSimulated(method)) throw new ApiError('conflict', 'That way has nothing to sign in with: its bridge, or nothing, is');
    const protocol = this.deps.protocols.get(method.protocol);
    const transport = await this.deps.transports.start(method.transport);
    const available = this.deps.transports.available(method.transport);
    if (!protocol || !transport || !available.ok) throw new ApiError('conflict', available.ok ? `${method.label} cannot be used here` : available.reason);
    const reach = overHardware(protocol, this.deps.transports.definition(method.transport), this.deps.transports);
    // What a person gives again: the way's credentials and its own steps — never finding it, never what the device itself is.
    const plan = setupPlan({ type, method, protocol, transport: reach.transport, platform: this.deps.transports.platform, values: transport.values?.() ?? {} }).filter(
      (step) => step.kind === 'check' || (step.kind === 'form' && step.target === 'connection') || (step.kind !== 'choose' && step.kind !== 'instructions' && 'target' in step && step.target === 'connection')
    );
    const draft = this.#newDraft({ by: input.by, heldBy: this.deps.self, type, method, reach, plan, address: connection.address, through: null, again: { deviceId: device.id, connectionId: connection.id, name: device.name, identity: device.identity } });
    draft.device = { ...device.config };
    draft.connection = { ...connection.config };
    return viewOf(draft);
  }

  /** Saves a way set up again: its settings and secrets given anew, and its device opened with them — nothing added. */
  async #saveAgain(draft: Draft): Promise<DeviceRecord> {
    const again = draft.again!;
    if (draft.checked?.outcome !== 'yours') throw new ApiError('conflict', 'Check it first: it must answer as the device it is');
    const schema = connectionSchema(draft.method, draft.reach.protocol);
    const settings = Object.fromEntries(Object.entries(draft.connection).filter(([field]) => schema.fields[field] && !isSecretField(schema.fields[field]!)));
    this.deps.db.transaction(() => {
      this.deps.connections.update(again.connectionId, { config: settings });
      if (draft.secrets.size) keepSecrets(this.deps, draft, again.connectionId);
    })();
    // Which fields, never their values.
    this.deps.record({
      at: new Date().toISOString(),
      kind: 'device.secrets-changed',
      actor: draft.by,
      resourceKind: 'device',
      resource: again.deviceId,
      summary: `Set up ${draft.method!.label} again for "${again.name}"${draft.secrets.size ? `: ${[...draft.secrets.keys()].join(', ')} given anew` : ''}`,
    });
    this.discard(draft.id);
    // Closed on purpose, so what it waited on is forgotten, and opened with what was given.
    await this.deps.sessions.close(again.deviceId);
    await this.deps.sessions.sync(this.deps.catalog.list());
    return this.deps.catalog.get(again.deviceId)!;
  }

  // --- internals ----------------------------------------------------------------------

  /** The members a draft through a bridge may be: of every bridge open here its way goes through, each saying which. */
  #members(draft: Draft): MemberOffer[] {
    return membersOnOffer(this.deps, draft.method?.through);
  }

  #newDraft(start: Pick<Draft, 'by' | 'heldBy' | 'type' | 'method' | 'reach' | 'plan' | 'address' | 'through'> & Partial<Pick<Draft, 'again'>>): Draft {
    const draft: Draft = {
      id: `s-${randomHex(8)}`,
      again: null,
      carried: new Map(),
      ...start,
      identityHint: null,
      device: {},
      connection: {},
      secrets: new Map(),
      placeholders: new Map(),
      checked: null,
      sightings: [],
      stopWatching: null,
      expiresAt: Date.now() + DRAFT_TTL_MS,
    };
    this.#drafts.set(draft.id, draft);
    this.#sweepWhileNeeded();
    return draft;
  }

  /** What a device's answer means, against the devices you have: new, yours, yours before, or another model. */
  #judge(draft: Draft, identified: Identified): CheckOutcome {
    draft.device = { ...draft.device, ...(identified.config ?? {}) };
    const outcome = judgeCheck(identified, {
      type: draft.type,
      types: this.deps.types.all(),
      identityHint: draft.identityHint,
      known: {
        byIdentity: (identity) => {
          const known = this.deps.catalog.byIdentity(identity);
          return { active: known.active, removed: known.removed.map((record) => ({ id: record.id, name: record.name, removedAt: record.removedAt! })) };
        },
      },
    });
    // Another model is not this device: what it said is not kept for the save.
    return this.#checked(draft, outcome, outcome.outcome === 'other-model' ? undefined : identified);
  }

  #draft(id: string): Draft {
    const draft = this.#drafts.get(id);
    if (!draft || draft.expiresAt < Date.now()) {
      if (draft) this.discard(id);
      throw new ApiError('not-found', 'That setup has expired; start again');
    }
    return draft;
  }

  #touch(draft: Draft): void {
    draft.expiresAt = Date.now() + DRAFT_TTL_MS;
  }

  #checked(draft: Draft, outcome: CheckOutcome, identified?: Identified): CheckOutcome {
    draft.checked = { ...outcome, identified };
    this.#touch(draft);
    return outcome;
  }

  #setupContext(draft: Draft, signal?: AbortSignal) {
    return {
      draft: draft.device as Partial<ConfigValues>,
      connection: draft.connection as ConfigValues,
      address: draft.address,
      secrets: { get: (field: string) => draft.secrets.get(field) ?? null },
      http: this.deps.http,
      sightings: draft.sightings,
      log: { info: () => {}, warn: (m: string) => console.warn(`[setup] ${m}`), error: (m: string) => console.error(`[setup] ${m}`) },
      signal: signal ?? AbortSignal.timeout(ACTION_TIMEOUT_MS),
      platform: this.deps.transports.platform,
    };
  }

  /**
   * Keeps any secret a helper returned, and hands back a placeholder in its
   * place. An unambiguous answer is applied to the draft straight away.
   */
  #hold(draft: Draft, target: 'device' | 'connection', result: SetupActionResult): SetupActionResult {
    const schema = target === 'connection' ? connectionSchema(draft.method, draft.reach.protocol) : draft.type.config;
    const secret = (field: string) => Boolean(schema.fields[field] && isSecretField(schema.fields[field]!));
    const shield = (config: ConfigValues): ConfigValues =>
      Object.fromEntries(
        Object.entries(config).map(([field, value]) => {
          if (!secret(field) || typeof value !== 'string') return [field, value];
          const placeholder = `held:${randomHex(8)}`;
          draft.placeholders.set(placeholder, value);
          return [field, placeholder];
        })
      );

    const shielded: SetupActionResult = {
      ...result,
      ...(result.choices ? { choices: result.choices.map((choice) => ({ ...choice, config: shield(choice.config) })) } : {}),
      ...(result.suggestedConfig ? { suggestedConfig: shield(result.suggestedConfig) } : {}),
    };
    if (shielded.suggestedConfig) this.update(draft.id, target === 'device' ? { device: shielded.suggestedConfig } : { connection: shielded.suggestedConfig });
    return shielded;
  }

  #sweep(): void {
    const now = Date.now();
    for (const [id, draft] of this.#drafts) if (draft.expiresAt < now) this.discard(id);
  }
}
