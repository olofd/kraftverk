import { randomBytes } from 'node:crypto';

import type { CheckOutcome, DraftView, HeldSetupInput, SaveInput, SightingView } from '@kraftverk/api-contract';

import {
  findStep,
  isLinkKind,
  isSecretField,
  LINK_KINDS,
  linkFits,
  openChannel,
  setupPlan,
  validateConfig,
  type Channel,
  type ConfigSchema,
  type ConfigValues,
  type ConnectionMethod,
  type DeviceType,
  type Identified,
  type OpenConnection,
  type Protocol,
  type SavedDeviceId,
  type ScopedHttp,
  type SetupActionResult,
  type SetupChoice,
  type SetupStepView,
  type Sighting,
  type TransportDefinition,
} from '@kraftverk/device-sdk';
import { judgeCheck, withTimeout } from '@kraftverk/holder';

import { audit, db } from '../history/db.ts';
import type { ProtocolRegistry } from '../runtime/protocols.ts';
import type { TransportHost } from '../runtime/transports.ts';
import type { DeviceCatalog, DeviceRecord } from './catalog.ts';
import type { ConnectionStore } from './connections.ts';
import type { LinkStore } from './links.ts';
import type { DeviceSessionManager } from './sessions.ts';
import type { DeviceTypeRegistry } from './types.ts';

/**
 * Adding a device, on the server (docs/DATA-MODEL.md §1).
 *
 * A **draft** is one person part-way through setting up one device the server
 * will hold. It lives here, in memory, for fifteen minutes, and nothing is
 * stored until it is saved: choosing a category and a type is the app's, and
 * from the connection method on, every step that touches the device runs here
 * — listing what the transport can see, fetching a key, reading the device
 * once — because this is where the connection will be held.
 *
 * Secrets a step finds stay here. The app is handed a placeholder in their
 * place, which saving turns back into the secret (see SECURITY.md).
 */

const DRAFT_TTL_MS = 15 * 60_000;
const CHECK_TIMEOUT_MS = 20_000;
const ACTION_TIMEOUT_MS = 90_000;
const PLACEHOLDER = /^held:[0-9a-f]{16}$/;

export class SetupError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400
  ) {
    super(message);
  }
}

type Draft = {
  id: string;
  by: string;
  /** Who will hold the connection: null for this server, or the app that ran the steps itself. */
  heldBy: string | null;
  type: DeviceType<any>;
  method: ConnectionMethod | null;
  protocol: Protocol | null;
  transport: TransportDefinition | null;
  plan: SetupStepView[];
  address: string | null;
  identityHint: string | null;
  device: Record<string, unknown>;
  connection: Record<string, unknown>;
  secrets: Map<string, string>;
  placeholders: Map<string, string>;
  checked: (CheckOutcome & { identified?: Identified }) | null;
  sightings: readonly Sighting[];
  stopWatching: (() => void) | null;
  expiresAt: number;
};

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
  /**
   * The server runs the simulator: no transport is started and no device is
   * read. Each method offers one simulated device, and the check passes, so
   * the whole flow can be tried without hardware.
   */
  simulate?: boolean;
};

/** The one device a simulated method offers. */
export const SIMULATED_ADDRESS = 'simulated';

const SIMULATED_VALUES: Readonly<Record<string, string>> = { host: 'this server’s address', port: 'its port' };

/** A save as the route has parsed it (`SaveInput` with its defaults applied). */
export type SaveRequest = SaveInput & Required<Pick<SaveInput, 'name' | 'mode'>>;

/** The schema of everything a connection stores for a method: its own config and its protocol's credentials. */
export function connectionSchema(method: ConnectionMethod | null, protocol: Protocol | null): ConfigSchema {
  return { fields: { ...(protocol?.credentials?.schema.fields ?? {}), ...(method?.config?.fields ?? {}) } };
}

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

    const method = input.methodId
      ? (type.connections.find((candidate) => candidate.id === input.methodId) ?? null)
      : type.connections.length === 1
        ? type.connections[0]!
        : null;
    if (!method) throw new SetupError(input.methodId ? `${type.meta.name} has no way called "${input.methodId}"` : 'Choose how to connect first');

    const protocol = this.deps.protocols.get(method.protocol);
    const transportDefinition = this.deps.transports.definition(method.transport);
    if (!protocol || !protocol.bindings[method.transport]) throw new SetupError(`This server cannot reach a ${type.meta.name} by ${method.label}: it needs updating`, 409);
    const simulate = this.deps.simulate ?? false;
    const transport = simulate ? null : await this.deps.transports.start(method.transport);
    if (!simulate) {
      const available = this.deps.transports.available(method.transport);
      if (!transport || !available.ok) throw new SetupError(available.ok ? `${method.label} cannot be used here` : available.reason, 409);
    }

    const draft: Draft = {
      id: `s-${randomBytes(8).toString('hex')}`,
      by: input.by,
      heldBy: null,
      type,
      method,
      protocol,
      transport: transportDefinition,
      // A simulator starts no transport, so its instructions get words where the addresses would be.
      plan: setupPlan({ type, method, protocol, transport: transportDefinition, platform: 'server', values: transport?.values?.() ?? (simulate ? SIMULATED_VALUES : {}) }),
      address: method.address ?? null,
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

    // What the transport can see, kept current for as long as the draft lives.
    if (simulate && !method.address) {
      draft.sightings = [{ transport: method.transport, address: SIMULATED_ADDRESS, seenAt: new Date().toISOString(), name: `Simulated ${type.meta.name}`, facts: {} }];
    } else if (transport?.watch && !method.address && transportDefinition?.discovery.server === 'list') {
      const binding = protocol.bindings[method.transport]!;
      draft.stopWatching = transport.watch(binding.filter ?? {}, (sightings) => {
        draft.sightings = sightings;
      });
    }

    this.#drafts.set(draft.id, draft);
    return this.#view(draft);
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
    const protocol = this.deps.protocols.get(method.protocol);
    const secret = new Set(
      Object.entries(connectionSchema(method, protocol).fields)
        .filter(([, spec]) => isSecretField(spec))
        .map(([field]) => field)
    );
    const connection = Object.fromEntries(Object.entries(input.connection ?? {}).filter(([field]) => !secret.has(field)));

    const draft: Draft = {
      id: `s-${randomBytes(8).toString('hex')}`,
      by: input.by,
      heldBy: input.clientId,
      type,
      method,
      protocol,
      transport: this.deps.transports.definition(method.transport),
      plan: [],
      address: input.address,
      identityHint: null,
      device: { ...(input.device ?? {}) },
      connection,
      secrets: new Map(),
      placeholders: new Map(),
      checked: null,
      sightings: [],
      stopWatching: null,
      expiresAt: Date.now() + DRAFT_TTL_MS,
    };
    this.#drafts.set(draft.id, draft);
    if (input.identified) this.#judge(draft, input.identified);
    else this.#checked(draft, { outcome: 'no-answer', summary: input.failure ?? 'It did not answer.', saveAnyway: type.setup?.saveAnyway ?? null });
    return this.#view(draft);
  }

  view(id: string): DraftView {
    return this.#view(this.#draft(id));
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
    const binding = draft.protocol?.bindings[draft.method!.transport];
    if (!binding) return [];
    const exclusive = draft.transport?.exclusive ?? true;
    if (this.deps.simulate) {
      return draft.sightings.map((sighting) => ({ address: sighting.address, name: sighting.name!, detail: 'No hardware is reached', identity: null, seenAt: sighting.seenAt, rssi: null, claimedBy: null }));
    }
    return draft.sightings.flatMap((sighting): SightingView[] => {
      const recognised = binding.recognise(sighting);
      if (!recognised) return [];
      const claim = exclusive ? this.deps.connections.claimant(draft.method!.transport, sighting.address) : null;
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
    const binding = draft.protocol?.bindings[draft.method!.transport];
    if (!binding) throw new SetupError('This method has nothing to choose');

    if (input.manual !== undefined) {
      const address = binding.parseAddress?.(input.manual) ?? null;
      if (!address) throw new SetupError(binding.parseAddress ? `That is not a ${binding.addressLabel ?? 'valid address'}` : 'An address cannot be typed for this');
      draft.address = address;
      draft.identityHint = null;
    } else {
      const sighting = draft.sightings.find((candidate) => candidate.address.toLowerCase() === input.address?.toLowerCase());
      const recognised = sighting && this.deps.simulate ? { name: sighting.name ?? '' } : sighting ? binding.recognise(sighting) : null;
      if (!sighting || !recognised) throw new SetupError('That device is not in the list any more; choose again');
      draft.address = sighting.address;
      draft.identityHint = recognised.identity ?? null;
      // What the sighting already says — a Tuya device's id and version — fills in the connection.
      draft.connection = { ...draft.connection, ...(recognised.config ?? {}) };
    }
    draft.checked = null;
    this.#touch(draft);
    return this.#view(draft);
  }

  /** Values entered in a form step, for the device or for its connection. Secrets stay here. */
  update(id: string, input: { device?: ConfigValues; connection?: ConfigValues }): DraftView {
    const draft = this.#draft(id);
    const schema = connectionSchema(draft.method, draft.protocol);
    if (input.device) {
      for (const [field, value] of Object.entries(input.device)) {
        if (!(field in draft.type.config.fields)) throw new SetupError(`${draft.type.meta.name} has no setting "${field}"`);
        draft.device[field] = value;
      }
    }
    if (input.connection) {
      for (const [field, value] of Object.entries(input.connection)) {
        const spec = schema.fields[field];
        if (!spec) throw new SetupError(`This connection has no setting "${field}"`);
        if (isSecretField(spec)) {
          if (typeof value !== 'string' || !value) continue;
          // A placeholder the app was handed stands for a secret already here — and only one it was handed.
          if (PLACEHOLDER.test(value)) {
            const held = draft.placeholders.get(value);
            if (held === undefined) throw new SetupError('That value has expired; fetch it again');
            draft.secrets.set(field, held);
          } else {
            draft.secrets.set(field, value);
          }
        } else {
          draft.connection[field] = value;
        }
      }
    }
    draft.checked = null;
    this.#touch(draft);
    return this.#view(draft);
  }

  /** Runs a step's helper — "Fetch it with my Tuya account" — here, and holds any secret it finds. */
  async action(id: string, stepId: string, actionId: string, input: ConfigValues, signal?: AbortSignal): Promise<SetupActionResult> {
    const draft = this.#draft(id);
    const step = findStep(draft.type, draft.method, draft.protocol, stepId);
    if (!step || step.kind !== 'form') throw new SetupError('No such step', 404);
    const action = step.actions?.find((candidate) => candidate.id === actionId);
    if (!action) throw new SetupError('No such action', 404);

    const result = await withTimeout(
      action.run(this.#setupContext(draft, signal), input),
      action.label,
      ACTION_TIMEOUT_MS
    ).catch((error: unknown) => ({ ok: false, detail: (error as Error).message }) as SetupActionResult);
    return this.#hold(draft, step.target, result);
  }

  /** A step of the type's own that finds candidates. */
  async discover(id: string, stepId: string, signal?: AbortSignal): Promise<SetupActionResult> {
    const draft = this.#draft(id);
    const step = findStep(draft.type, draft.method, draft.protocol, stepId);
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
   * Reads the device once: the check step.
   *
   * A device already reached at this address is yours without asking it. Any
   * other is opened, asked who it is by its type's `identify`, and let go; what
   * it says decides the outcome — new, yours, yours before, another model.
   */
  async check(id: string): Promise<CheckOutcome> {
    const draft = this.#draft(id);
    const method = draft.method!;
    if (!draft.address) throw new SetupError('Choose the device first');

    if (this.deps.simulate) {
      return this.#checked(draft, { outcome: 'new', summary: 'Simulated: no hardware was read, and none will be.', identity: null });
    }

    if (draft.transport?.exclusive !== false) {
      const claim = this.deps.connections.claimant(method.transport, draft.address);
      const claimed = claim ? this.deps.catalog.active(claim.deviceId) : null;
      if (claimed) {
        return this.#checked(draft, { outcome: 'yours', summary: `This is your ${claimed.name}, already reached this way.`, device: { id: claimed.id, name: claimed.name } });
      }
    }

    let channel: Channel | null = null;
    let identified: Identified;
    try {
      channel = await openChannel(this.deps.transports, draft.protocol, { transport: method.transport, address: draft.address });
      const connection: OpenConnection = {
        method: method.id,
        protocol: method.protocol,
        transport: method.transport,
        address: draft.address,
        channel,
        config: draft.connection as ConfigValues,
        secrets: { get: (field) => draft.secrets.get(field) ?? null },
        platform: 'server',
      };
      const quiet = { info: () => {}, warn: (m: string) => console.warn(`[setup] ${m}`), error: (m: string) => console.error(`[setup] ${m}`) };
      identified = await withTimeout(
        draft.type.identify(connection, { config: draft.device as ConfigValues, log: quiet, signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) }),
        `Reading the ${draft.type.meta.name}`,
        CHECK_TIMEOUT_MS
      );
    } catch (error) {
      return this.#checked(draft, { outcome: 'no-answer', summary: (error as Error).message, saveAnyway: draft.type.setup?.saveAnyway ?? null });
    } finally {
      await channel?.close().catch(() => undefined);
    }

    return this.#judge(draft, identified);
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

  /**
   * Saves: in one go, the device (or the one it turned out to be), its
   * connection, that connection's secrets, and its links. Then its session opens.
   */
  async save(id: string, input: SaveRequest): Promise<DeviceRecord> {
    const draft = this.#draft(id);
    const method = draft.method!;
    const checked = draft.checked;
    const type = draft.type;

    if (!draft.address) throw new SetupError('Choose the device first');
    if (!checked) throw new SetupError('Check that it answers first');
    if (checked.outcome === 'other-model') throw new SetupError(checked.summary, 409);
    if (checked.outcome === 'no-answer' && !(input.anyway && type.setup?.saveAnyway)) {
      throw new SetupError(type.setup?.saveAnyway ? 'It did not answer. Save it anyway, or try again.' : 'It did not answer, so it cannot be saved.', 409);
    }

    const device = validateConfig(type.config, draft.device);
    if (!device.ok) throw new SetupError(device.issues.map((issue) => issue.message).join('; '));
    const schema = connectionSchema(method, draft.protocol);
    // A simulated device reaches nothing, so it needs no device id and no key: what is given is still checked.
    const simulated = this.deps.simulate ?? false;
    const nonSecret: ConfigSchema = {
      fields: Object.fromEntries(
        Object.entries(schema.fields)
          .filter(([, spec]) => !isSecretField(spec))
          .map(([field, spec]) => [field, simulated ? { ...spec, required: false } : spec])
      ),
    };
    const connection = validateConfig(nonSecret, Object.fromEntries(Object.entries(draft.connection).filter(([field]) => field in nonSecret.fields)));
    if (!connection.ok) throw new SetupError(connection.issues.map((issue) => issue.message).join('; '));
    for (const [field, spec] of Object.entries(schema.fields)) {
      if (!simulated && draft.heldBy === null && isSecretField(spec) && 'required' in spec && spec.required && !draft.secrets.get(field)) throw new SetupError(`${spec.title} is required`);
    }

    // All or nothing: a device saved without its connection could never be reached.
    const { record, kind } = db().transaction(() => this.#write(draft, input, device.value, connection.value))();

    audit({
      at: new Date().toISOString(),
      kind,
      actor: draft.by,
      resource: record.id,
      summary:
        kind === 'device.added'
          ? `Added "${record.name}" (${type.meta.name}) over ${method.label}`
          : kind === 'device.restored'
            ? `Brought back "${record.name}" with its history, over ${method.label}`
            : `Added ${method.label} as another way to reach "${record.name}"`,
      detail: { typeId: type.id, method: method.id, transport: method.transport, links: input.links ?? [] },
    });

    this.discard(id);
    await this.deps.sessions.sync(this.deps.catalog.list());
    return record;
  }

  #write(draft: Draft, input: SaveRequest, deviceConfig: ConfigValues, connectionConfig: ConfigValues): { record: DeviceRecord; kind: string } {
    const method = draft.method!;
    const checked = draft.checked!;
    const type = draft.type;
    const address = draft.address!;

    // Which device this is.
    let record: DeviceRecord;
    let kind: string;
    if (input.mode === 'attach') {
      const existing = input.deviceId ? this.deps.catalog.active(input.deviceId as SavedDeviceId) : null;
      if (!existing) throw new SetupError('That device has gone', 404);
      if (existing.typeId !== type.id) throw new SetupError(`${existing.name} is not a ${type.meta.name}`, 409);
      /*
        Another way to reach a device must reach *that* device: the check has
        to find it. The one exception is a device saved before it ever answered,
        which has no identity yet — the first to find one gives it.
      */
      const same = checked.outcome === 'yours' && checked.device.id === existing.id;
      const first = checked.outcome === 'new' && existing.identity === null;
      // A browser shows no MAC, so its answer cannot say which station it is: then the person says.
      const onTheirWord = checked.outcome === 'new' && checked.identity === null;
      if (!same && !first && !onTheirWord) throw new SetupError(`That is a different device, not ${existing.name}`, 409);
      if (first && checked.identity) this.deps.catalog.update(existing.id, { identity: checked.identity });
      if (this.deps.connections.forDevice(existing.id).some((c) => c.method === method.id && c.heldBy === draft.heldBy)) {
        throw new SetupError(`${existing.name} is already reached this way`, 409);
      }
      record = existing;
      kind = 'device.connection-added';
    } else if (input.mode === 'restore') {
      if (checked.outcome !== 'removed' || !checked.devices.some((candidate) => candidate.id === input.deviceId)) {
        throw new SetupError('That is not a device this was before', 409);
      }
      record = this.deps.catalog.restore(input.deviceId as SavedDeviceId) ?? (() => { throw new SetupError('That device cannot be brought back', 409); })();
      record = this.deps.catalog.update(record.id, { name: input.name.trim() || record.name, config: deviceConfig }) ?? record;
      kind = 'device.restored';
    } else {
      if (checked.outcome === 'yours') throw new SetupError(`You already have this device: ${checked.device.name}`, 409);
      const identity = checked.outcome === 'new' || checked.outcome === 'removed' ? (checked.identity ?? null) : null;
      record = this.deps.catalog.add({ typeId: type.id, name: input.name.trim() || type.meta.name, identity, config: deviceConfig, description: type.describe(deviceConfig) });
      kind = 'device.added';
    }

    // An exclusive address belongs to one device.
    if (draft.transport?.exclusive !== false && !this.deps.simulate && draft.heldBy === null) {
      const claim = this.deps.connections.claimant(method.transport, address);
      if (claim && claim.deviceId !== record.id) throw new SetupError('Another device you have is already reached at that address', 409);
    }

    const saved = this.deps.connections.add({
      deviceId: record.id,
      method: method.id,
      transport: method.transport,
      heldBy: draft.heldBy,
      address,
      config: connectionConfig,
    });
    if (draft.secrets.size) this.deps.connections.setSecrets(saved.id, Object.fromEntries(draft.secrets));

    for (const link of input.links ?? []) {
      if (!isLinkKind(link.kind)) throw new SetupError(`There is no link called "${link.kind}"`);
      const other = this.deps.catalog.active(link.other as SavedDeviceId);
      if (!other) throw new SetupError('The device to link to has gone', 404);
      const [source, target, sourceDescription, targetDescription] =
        link.role === 'source' ? [record.id, other.id, record.description, other.description] : [other.id, record.id, other.description, record.description];
      if (!linkFits(link.kind, sourceDescription, targetDescription)) throw new SetupError(`${LINK_KINDS[link.kind].verb} does not fit those two devices`);
      this.deps.links.add({ kind: link.kind, sourceId: source, targetId: target });
    }
    return { record, kind };
  }

  // --- internals ----------------------------------------------------------------------

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
    const schema = target === 'connection' ? connectionSchema(draft.method, draft.protocol) : draft.type.config;
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

  #view(draft: Draft): DraftView {
    return {
      id: draft.id,
      heldBy: draft.heldBy,
      typeId: draft.type.id,
      methodId: draft.method?.id ?? null,
      plan: draft.plan,
      address: draft.address,
      device: draft.device,
      connection: draft.connection,
      secrets: [...draft.secrets.keys()],
      checked: draft.checked ? stripIdentified(draft.checked) : null,
      expiresAt: new Date(draft.expiresAt).toISOString(),
    };
  }

  #sweep(): void {
    const now = Date.now();
    for (const [id, draft] of this.#drafts) if (draft.expiresAt < now) this.discard(id);
  }
}

const stripIdentified = (checked: CheckOutcome & { identified?: Identified }): CheckOutcome => {
  const { identified: _identified, ...rest } = checked;
  return rest as CheckOutcome;
};
