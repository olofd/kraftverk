import { randomBytes } from 'node:crypto';

import type { CheckOutcome, DraftView, HeldSetupInput, SightingView } from '@kraftverk/api-contract';
import {
  clientId,
  findStep,
  isSecretField,
  isSimulated,
  methodOf,
  setupPlan,
  type ConfigValues,
  type Identified,
  type ScopedHttp,
  type SetupActionResult,
  type SetupChoice,
} from '@kraftverk/device-sdk';
import { judgeCheck, withTimeout } from '@kraftverk/holder';

import { audit, db } from '../../history/db.ts';
import type { ProtocolRegistry } from '../../runtime/protocols.ts';
import type { TransportHost } from '../../runtime/transports.ts';
import type { DeviceCatalog, DeviceRecord } from '../catalog.ts';
import type { ConnectionStore } from '../connections.ts';
import type { LinkStore } from '../links.ts';
import type { DeviceSessionManager } from '../sessions.ts';
import type { DeviceTypeRegistry } from '../types.ts';
import { connectionSchema, DRAFT_TTL_MS, SetupError, viewOf, type Draft, type SaveRequest } from './draft.ts';
import { overHardware, SIMULATED_REACH } from './reach.ts';
import { saveable, writeSaved } from './save.ts';

export { connectionSchema, SetupError, type SaveRequest } from './draft.ts';

/**
 * Adding a device, on the server (docs/DATA-MODEL.md §1).
 *
 * A **draft** is one person part-way through setting up one device the server
 * will hold (`draft.ts`). Choosing a category and a type is the app's; from
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
  types: DeviceTypeRegistry;
  protocols: ProtocolRegistry;
  transports: TransportHost;
  catalog: DeviceCatalog;
  connections: ConnectionStore;
  links: LinkStore;
  sessions: DeviceSessionManager;
  /** For helpers that call a vendor's API once — fetching a key. */
  http: ScopedHttp;
};

export class SetupService {
  #drafts = new Map<string, Draft>();
  #sweeper: ReturnType<typeof setInterval>;

  constructor(private deps: SetupServiceDeps) {
    this.#sweeper = setInterval(() => this.#sweep(), 60_000);
    this.#sweeper.unref?.();
  }

  stop(): void {
    clearInterval(this.#sweeper);
    for (const id of [...this.#drafts.keys()]) this.discard(id);
  }

  /**
   * Begins setting up a device of `typeId`, over `methodId`, held by this
   * server. Refused when the method's transport cannot be used here, saying why.
   */
  async start(input: { typeId: string; methodId?: string | null; by: string }): Promise<DraftView> {
    const type = this.deps.types.get(input.typeId);
    if (!type) throw new SetupError(`Nothing installed here knows what "${input.typeId}" is`, 404);

    const method = input.methodId ? methodOf(type, input.methodId) : type.connections.length === 1 ? type.connections[0]! : null;
    if (!method) throw new SetupError(input.methodId ? `${type.meta.name} has no way called "${input.methodId}"` : 'Choose how to connect first');

    // Simulated: nothing to reach, so no protocol and no transport — only the type's own steps, then its simulator.
    let reach = SIMULATED_REACH;
    let transport = null;
    if (!isSimulated(method)) {
      const protocol = this.deps.protocols.get(method.protocol);
      if (!protocol?.bindings[method.transport]) throw new SetupError(`This server cannot reach a ${type.meta.name} by ${method.label}: it needs updating`, 409);
      transport = await this.deps.transports.start(method.transport);
      const available = this.deps.transports.available(method.transport);
      if (!transport || !available.ok) throw new SetupError(available.ok ? `${method.label} cannot be used here` : available.reason, 409);
      reach = overHardware(protocol, this.deps.transports.definition(method.transport), this.deps.transports);
    }

    const draft = this.#newDraft({
      by: input.by,
      heldBy: null,
      type,
      method,
      reach,
      plan: setupPlan({ type, method, protocol: reach.protocol, transport: reach.transport, platform: 'server', values: transport?.values?.() ?? {} }),
      address: method.address ?? null,
    });

    // What the transport can see, kept current for as long as the draft lives.
    const binding = reach.protocol?.bindings[method.transport];
    if (binding && transport?.watch && !method.address && reach.transport?.discovery.server === 'list') {
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
    if (!type) throw new SetupError(`Nothing installed here knows what "${input.typeId}" is`, 404);
    const method = type.connections.find((candidate) => candidate.id === input.methodId);
    if (!method) throw new SetupError(`${type.meta.name} has no way called "${input.methodId}"`);
    if (method.serverOnly) throw new SetupError(`${method.label} is held only by your server: ${method.serverOnly}`);
    const protocol = this.deps.protocols.get(method.protocol) ?? null;
    const secret = new Set(
      Object.entries(connectionSchema(method, protocol).fields)
        .filter(([, spec]) => isSecretField(spec))
        .map(([field]) => field)
    );
    const draft = this.#newDraft({
      by: input.by,
      heldBy: clientId(input.clientId),
      type,
      method,
      reach: overHardware(protocol, this.deps.transports.definition(method.transport), this.deps.transports),
      plan: [],
      address: input.address,
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
    if (this.#draft(id).by !== by) throw new SetupError('That setup has expired; start again', 404);
  }

  discard(id: string): void {
    const draft = this.#drafts.get(id);
    draft?.stopWatching?.();
    this.#drafts.delete(id);
  }

  /** What the transport sees that this device's protocol recognises, each marked when it is already yours. */
  sightings(id: string): SightingView[] {
    const draft = this.#draft(id);
    const binding = draft.reach.protocol?.bindings[draft.method!.transport];
    if (!binding) return [];
    return draft.sightings.flatMap((sighting): SightingView[] => {
      const recognised = binding.recognise(sighting);
      if (!recognised) return [];
      const claim = draft.reach.exclusive ? this.deps.connections.claimant(draft.method!.transport, sighting.address) : null;
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
        },
      ];
    });
  }

  /** The physical device: one the transport saw, or an address typed by hand. */
  choose(id: string, input: { address?: string; manual?: string }): DraftView {
    const draft = this.#draft(id);
    const binding = draft.reach.protocol?.bindings[draft.method!.transport];
    if (!binding) throw new SetupError('This method has nothing to choose');

    if (input.manual !== undefined) {
      const address = binding.parseAddress?.(input.manual) ?? null;
      if (!address) throw new SetupError(binding.parseAddress ? `That is not a ${binding.addressLabel ?? 'valid address'}` : 'An address cannot be typed for this');
      draft.address = address;
      draft.identityHint = null;
    } else {
      const sighting = draft.sightings.find((candidate) => candidate.address.toLowerCase() === input.address?.toLowerCase());
      const recognised = sighting ? binding.recognise(sighting) : null;
      if (!sighting || !recognised) throw new SetupError('That device is not in the list any more; choose again');
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
      if (!(field in draft.type.config.fields)) throw new SetupError(`${draft.type.meta.name} has no setting "${field}"`);
      draft.device[field] = value;
    }
    for (const [field, value] of Object.entries(input.connection ?? {})) {
      const spec = schema.fields[field];
      if (!spec) throw new SetupError(`This connection has no setting "${field}"`);
      if (!isSecretField(spec)) {
        draft.connection[field] = value;
        continue;
      }
      if (typeof value !== 'string' || !value) continue;
      // A placeholder the app was handed stands for a secret already here — and only one it was handed.
      if (PLACEHOLDER.test(value)) {
        const held = draft.placeholders.get(value);
        if (held === undefined) throw new SetupError('That value has expired; fetch it again');
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
    if (!step || step.kind !== 'form') throw new SetupError('No such step', 404);
    const action = step.actions?.find((candidate) => candidate.id === actionId);
    if (!action) throw new SetupError('No such action', 404);
    const result = await withTimeout(action.run(this.#setupContext(draft, signal), input), action.label, ACTION_TIMEOUT_MS).catch(
      (error: unknown) => ({ ok: false, detail: (error as Error).message }) as SetupActionResult
    );
    return this.#hold(draft, step.target, result);
  }

  /** A step of the type's own that finds candidates. */
  async discover(id: string, stepId: string, signal?: AbortSignal): Promise<SetupActionResult> {
    const draft = this.#draft(id);
    const step = findStep(draft.type, draft.method, draft.reach.protocol, stepId);
    if (!step || step.kind !== 'discover') throw new SetupError('No such step', 404);
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
    if (!draft.address) throw new SetupError('Choose the device first');

    if (draft.reach.exclusive) {
      const claim = this.deps.connections.claimant(method.transport, draft.address);
      const claimed = claim ? this.deps.catalog.active(claim.deviceId) : null;
      if (claimed) return this.#checked(draft, { outcome: 'yours', summary: `This is your ${claimed.name}, already reached this way.`, device: { id: claimed.id, name: claimed.name } });
    }
    const read = await draft.reach.identify(draft);
    return 'outcome' in read ? this.#checked(draft, read.outcome) : this.#judge(draft, read.identified);
  }

  /**
   * Saves: in one go, the device (or the one it turned out to be), its
   * connection, that connection's secrets, and its links. Then its session opens.
   */
  async save(id: string, input: SaveRequest): Promise<DeviceRecord> {
    const draft = this.#draft(id);
    const method = draft.method!;
    const config = saveable(draft, input);
    const { record, kind } = db().transaction(() => writeSaved(this.deps, draft, input, config))();

    audit({
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

  // --- internals ----------------------------------------------------------------------

  #newDraft(start: Pick<Draft, 'by' | 'heldBy' | 'type' | 'method' | 'reach' | 'plan' | 'address'>): Draft {
    const draft: Draft = {
      id: `s-${randomBytes(8).toString('hex')}`,
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
      throw new SetupError('That setup has expired; start again', 404);
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
      platform: 'server' as const,
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
          const placeholder = `held:${randomBytes(8).toString('hex')}`;
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
