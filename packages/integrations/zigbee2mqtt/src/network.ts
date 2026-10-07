import { identityOf, type Bridge, type ChannelMessage, type Joining, type Member, type MessageChannel } from '@kraftverk/device-sdk';

import type { MemberAbout, Press, ZigbeeLink } from './link.ts';
import {
  actionOf,
  groupExposes,
  ieeeKey,
  objectOf,
  parseJson,
  parseTopic,
  shapeOf,
  TOPIC,
  type BridgeDevice,
  type BridgeEvent,
  type BridgeGroup,
  type BridgeInfo,
  type BridgeResponse,
  type Shape,
} from './protocol/index.ts';

/*
  A Zigbee network, as Zigbee2MQTT tells it over one channel
  (docs/PLAN-ZIGBEE.md §5.2): its bridge's state and info, its devices and
  groups, each one's state and availability, and requests matched to their
  answers by `transaction`. The coordinator's session and its simulator are
  this over different channels; the devices and groups behind it read it
  through their links.
*/

/** A group's member key: `group:<id>`, beside the devices' IEEE addresses. */
export const groupKey = (id: number): string => `group:${id}`;

const groupIdOf = (key: string): number | null => {
  const match = /^group:(\d+)$/.exec(key);
  return match ? Number(match[1]) : null;
};

/** A Zigbee device's identity: the same whoever drives the radio (§2). */
const zigbeeIdentity = (key: string): string => identityOf('zigbee', key);

/** The longest Zigbee lets a network stay open for joining at once. */
const MAX_JOIN_SECONDS = 254;

/** How long letting devices join waits for Zigbee2MQTT to say its new end, after it answered. */
const INFO_WAIT_MS = 3000;

/** A press said this long before the network began listening still counts: one pressed as the server started. */
const PRESS_GRACE_MS = 2000;

/** The most said on topics nothing is named by yet that is kept to hear again: a device list late by a moment, not a flood. */
const MAX_UNNAMED = 200;

/** How long a request waits for its answer. */
const REQUEST_TIMEOUT_MS = 10_000;

type Linked = { changed: () => void; presses: Press[] };

type Kept = { values: Record<string, unknown>; at: string | null };

export type NetworkContext = {
  /** Told whenever who is behind it, or what it says of itself, changed. */
  changed(): void;
  log(message: string): void;
  now(): number;
};

export class ZigbeeNetwork implements Bridge<ZigbeeLink> {
  #bridgeOnline: boolean | null = null;
  #info: BridgeInfo | null = null;
  #devices = new Map<string, BridgeDevice>();
  #byName = new Map<string, string>();
  #groups = new Map<number, BridgeGroup>();
  #shapes = new Map<string, Shape | null>();
  #states = new Map<string, Kept>();
  #available = new Map<string, boolean>();
  #links = new Map<string, Set<Linked>>();
  #pending = new Map<string, { resolve: (data: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  #transaction = 0;
  #heardAt: string | null = null;
  /** Told when Zigbee2MQTT says its info again. */
  #infoWaiters = new Set<() => void>();
  /** What was said on a topic no device or group is named by yet, by its topic: heard again once one is. */
  #unnamed = new Map<string, ChannelMessage>();
  /** When each device last spoke, by its own time (`last_seen`): a press is one said after it. */
  #lastSeen = new Map<string, number>();
  /** When this network began listening: a state said before then holds no press. */
  readonly #startedAt: number;
  #unsubscribe: (() => void) | null = null;

  constructor(
    private readonly channel: MessageChannel,
    private readonly ctx: NetworkContext
  ) {
    this.#startedAt = ctx.now();
  }

  /** Listens to everything Zigbee2MQTT says: what it keeps comes first. */
  start(): void {
    this.#unsubscribe = this.channel.subscribe(TOPIC.all, (message) => this.#hear(message));
  }

  close(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    for (const [, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('The coordinator was closed'));
    }
    this.#pending.clear();
  }

  // --- what it is now -----------------------------------------------------

  /** Whether Zigbee2MQTT is there: its client on the broker, and its own word that it is online. */
  get connected(): boolean {
    return this.channel.connected && this.#bridgeOnline === true;
  }

  /** What Zigbee2MQTT last said it is: null before it has, false when it said offline (its last will). */
  get bridgeOnline(): boolean | null {
    return this.#bridgeOnline;
  }

  get info(): BridgeInfo | null {
    return this.#info;
  }

  get heardAt(): string | null {
    return this.#heardAt;
  }

  /** The coordinator's own identity, once Zigbee2MQTT has said its IEEE address. */
  get identity(): string | null {
    const key = ieeeKey(this.#info?.coordinator?.ieee_address);
    return key ? zigbeeIdentity(key) : null;
  }

  devices(): BridgeDevice[] {
    return [...this.#devices.values()];
  }

  groups(): BridgeGroup[] {
    return [...this.#groups.values()];
  }

  /** The device a name or an IEEE address names, by its key. */
  keyOf(nameOrAddress: string): string | null {
    return this.#byName.get(nameOrAddress) ?? (ieeeKey(nameOrAddress) && this.#devices.has(ieeeKey(nameOrAddress)!) ? ieeeKey(nameOrAddress) : null);
  }

  // --- the bridge -------------------------------------------------------------

  members(): Member[] {
    const devices = [...this.#devices.entries()].map(([key, device]): Member => {
      const shape = this.#shapes.get(key) ?? null;
      const joining = !device.definition || device.interview_state === 'PENDING' || device.interview_state === 'IN_PROGRESS';
      const named = device.friendly_name && ieeeKey(device.friendly_name) !== key ? device.friendly_name : null;
      return {
        key,
        name: named ?? (device.definition ? `${device.definition.vendor} ${device.definition.model}` : null),
        model: device.definition?.model ?? device.model_id ?? null,
        identity: zigbeeIdentity(key),
        typeId: shape && !joining ? `zigbee2mqtt.${shape.shelf}` : null,
        about: device.definition ? `${device.definition.vendor} ${device.definition.description}${device.definition.source === 'generated' ? ' (guessed from what it said)' : ''}` : null,
        joining,
      };
    });
    const groups = [...this.#groups.values()].map((group): Member => {
      const key = groupKey(group.id);
      const shape = this.#shapes.get(key) ?? null;
      return {
        key,
        name: group.friendly_name,
        model: null,
        identity: this.#groupIdentity(group.id),
        typeId: shape?.shelf === 'light' ? 'zigbee2mqtt.light-group' : 'zigbee2mqtt.group',
        about: `A Zigbee group of ${group.members.length === 1 ? '1 device' : `${group.members.length} devices`}`,
        joining: false,
      };
    });
    return [...devices, ...groups];
  }

  async link(key: string, changed: () => void): Promise<ZigbeeLink> {
    const isGroup = groupIdOf(key) !== null;
    if (!isGroup && !ieeeKey(key)) throw new Error(`"${key}" is not a Zigbee device's address`);
    const linked: Linked = { changed, presses: [] };
    let set = this.#links.get(key);
    if (!set) this.#links.set(key, (set = new Set()));
    set.add(linked);
    return {
      shape: () => this.#shapes.get(key) ?? null,
      about: () => this.#about(key),
      state: () => this.#states.get(key) ?? { values: {}, at: null },
      takePresses: () => linked.presses.splice(0),
      available: () => this.#availableOf(key),
      connected: () => this.connected,
      identity: () => (isGroup ? this.#groupIdentity(groupIdOf(key)!) : zigbeeIdentity(key)),
      set: (payload) => this.#publish(this.#setTopic(key), payload),
      get: (payload) => this.#publish(this.#getTopic(key), payload),
      close: () => void set!.delete(linked),
    };
  }

  readonly join: Joining = {
    maxSeconds: MAX_JOIN_SECONDS,
    open: async (seconds) => {
      const time = Math.max(0, Math.min(MAX_JOIN_SECONDS, Math.round(seconds)));
      const before = this.#info?.permit_join_end ?? null;
      await this.request('permit_join', { time });
      /*
        Zigbee2MQTT answers first and says its new end in its info after: what
        is told back is that end once it has said it — or, if it is slow to,
        the end the request asked for.
      */
      const said = () => (time === 0 ? !this.#info?.permit_join : this.#info?.permit_join === true && (this.#info.permit_join_end ?? null) !== before);
      await this.#infoSays(said, INFO_WAIT_MS);
      return said() ? this.#joinUntil() : time ? new Date(this.ctx.now() + time * 1000).toISOString() : null;
    },
    until: () => this.#joinUntil(),
  };

  #joinUntil(): string | null {
    if (!this.#info?.permit_join) return null;
    const end = this.#info.permit_join_end;
    return typeof end === 'number' && end > this.ctx.now() ? new Date(end).toISOString() : null;
  }

  /** Resolves once its info says what `said` looks for, or after `ms`. */
  #infoSays(said: () => boolean, ms: number): Promise<void> {
    if (said()) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.#infoWaiters.delete(check);
        resolve();
      };
      const check = () => {
        if (said()) done();
      };
      const timer = setTimeout(done, ms);
      this.#infoWaiters.add(check);
    });
  }

  /**
   * Asks Zigbee2MQTT something on `bridge/request/<what>`, and answers what
   * it says back — matched by `transaction`, so two at once cannot take each
   * other's. Rejects with its error, or after ten seconds of silence.
   */
  request(what: string, payload: Record<string, unknown>, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
    const transaction = `kv-${(++this.#transaction).toString(36)}-${this.ctx.now().toString(36)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(transaction);
        reject(new Error(`Zigbee2MQTT did not answer ${what} within ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      this.#pending.set(transaction, { resolve, reject, timer });
      this.#publish(TOPIC.request(what), { ...payload, transaction }).catch((error: Error) => {
        clearTimeout(timer);
        this.#pending.delete(transaction);
        reject(error);
      });
    });
  }

  // --- hearing it -------------------------------------------------------------

  #hear(message: ChannelMessage): void {
    this.#heardAt = message.at;
    const parsed = parseTopic(message.topic);
    if (!parsed) return;
    if ('bridge' in parsed) return this.#bridge(parsed.bridge, message);
    if (parsed.verb === 'set' || parsed.verb === 'get' || parsed.verb === 'other') return;
    const key = this.#keyOfName(parsed.name);
    if (!key) {
      // Said before its device list named it — a device just joined, or a replay in another order: heard again once it is named.
      if (this.#unnamed.size < MAX_UNNAMED || this.#unnamed.has(message.topic)) this.#unnamed.set(message.topic, message);
      return;
    }
    const json = objectOf(parseJson(message.payload));
    if (parsed.verb === 'availability') {
      const state = json?.state;
      if (state === 'online' || state === 'offline') {
        this.#available.set(key, state === 'online');
        this.#tell(key);
      }
      return;
    }
    if (!json) return;
    const kept = this.#states.get(key) ?? { values: {}, at: null };
    /*
      When it was said: the device's own time where Zigbee2MQTT gives it
      (`last_seen`, as the deploy sets it) — a state kept on the broker and
      replayed is as old as the device last spoke, not as new as its replay.
    */
    const seen = typeof json.last_seen === 'string' && Number.isFinite(Date.parse(json.last_seen)) ? new Date(json.last_seen).toISOString() : null;
    const at = seen ?? (message.retained && kept.at ? kept.at : message.at);
    // Merged: a device that is not cached says only what changed.
    this.#states.set(key, { values: { ...kept.values, ...json }, at });
    const shape = this.#shapes.get(key);
    /*
      A press is one said now. A device's state is kept on the broker with
      its last `action` in it and replayed whenever the server or the broker
      starts — marked kept or not, depending on who replays it — so it is
      the device's own time that tells: a press is one said after the last
      this network heard from the device, and after it began listening.
    */
    const seenAt = seen ? Date.parse(seen) : null;
    const before = this.#lastSeen.get(key) ?? this.#startedAt - PRESS_GRACE_MS;
    if (seenAt !== null) this.#lastSeen.set(key, Math.max(seenAt, this.#lastSeen.get(key) ?? 0));
    const said = !message.retained && (seenAt === null || seenAt > before);
    const press = shape && said ? actionOf(shape, json) : null;
    if (press) for (const linked of this.#links.get(key) ?? []) linked.presses.push({ ...press, at: message.at });
    this.#tell(key);
  }

  #bridge(what: string, message: ChannelMessage): void {
    const json = parseJson(message.payload);
    switch (what) {
      case 'state': {
        const state = objectOf(json)?.state ?? new TextDecoder().decode(message.payload);
        this.#bridgeOnline = state === 'online';
        this.#tellAll();
        return;
      }
      case 'info':
        this.#info = objectOf(json) as BridgeInfo | null;
        for (const check of [...this.#infoWaiters]) check();
        this.ctx.changed();
        return;
      case 'devices':
        if (Array.isArray(json)) this.#takeDevices(json as BridgeDevice[]);
        return;
      case 'groups':
        if (Array.isArray(json)) this.#takeGroups(json as BridgeGroup[]);
        return;
      case 'event':
        this.#event(objectOf(json) as BridgeEvent | null);
        return;
      default:
        if (what.startsWith('response/')) this.#answer(objectOf(json) as BridgeResponse | null);
    }
  }

  /** Who is on the network now — the coordinator left out — and what each exposes: taken again every time, as exposes change (§5.6). */
  #takeDevices(list: readonly BridgeDevice[]): void {
    this.#devices.clear();
    this.#byName.clear();
    for (const device of list) {
      const key = ieeeKey(device.ieee_address);
      if (!key || device.type === 'Coordinator' || device.disabled) continue;
      this.#devices.set(key, device);
      this.#byName.set(device.friendly_name, key);
      this.#shapes.set(key, device.definition ? shapeOf(device.definition.exposes) : null);
    }
    for (const key of [...this.#shapes.keys()]) if (groupIdOf(key) === null && !this.#devices.has(key)) this.#shapes.delete(key);
    this.#shapeGroups();
    this.#hearUnnamed();
    this.ctx.changed();
    this.#tellAll();
  }

  #takeGroups(list: readonly BridgeGroup[]): void {
    this.#groups.clear();
    for (const group of list) if (typeof group.id === 'number') this.#groups.set(group.id, group);
    this.#shapeGroups();
    this.#hearUnnamed();
    this.ctx.changed();
    this.#tellAll();
  }

  /** What was said before anything was named by its topic, heard now if something is. */
  #hearUnnamed(): void {
    for (const [topic, message] of [...this.#unnamed]) {
      const parsed = parseTopic(topic);
      if (!parsed || 'bridge' in parsed || !this.#keyOfName(parsed.name)) continue;
      this.#unnamed.delete(topic);
      this.#hear(message);
    }
  }

  /** Each group's shape: what its members can do (§5.4). */
  #shapeGroups(): void {
    for (const key of [...this.#shapes.keys()]) if (groupIdOf(key) !== null && !this.#groups.has(groupIdOf(key)!)) this.#shapes.delete(key);
    for (const group of this.#groups.values()) {
      const exposes = group.members.flatMap((member) => {
        const definition = this.#devices.get(ieeeKey(member.ieee_address) ?? '')?.definition;
        return definition ? [definition.exposes] : [];
      });
      this.#shapes.set(groupKey(group.id), exposes.length ? shapeOf(groupExposes(exposes)) : null);
    }
  }

  #event(event: BridgeEvent | null): void {
    if (!event) return;
    const name = event.data?.friendly_name ?? event.data?.ieee_address ?? 'a device';
    if (event.type === 'device_joined') this.ctx.log(`${name} joined the Zigbee network`);
    else if (event.type === 'device_interview') this.ctx.log(`${name}: interview ${event.data?.status ?? '?'}`);
    else if (event.type === 'device_leave') this.ctx.log(`${name} left the Zigbee network`);
  }

  #answer(response: BridgeResponse | null): void {
    if (!response?.transaction) return;
    const pending = this.#pending.get(response.transaction);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.#pending.delete(response.transaction);
    if (response.status === 'ok') pending.resolve(response.data ?? null);
    else pending.reject(new Error(response.error ?? 'Zigbee2MQTT refused it'));
  }

  // --- helpers ------------------------------------------------------------------

  #keyOfName(name: string): string | null {
    const device = this.#byName.get(name) ?? ieeeKey(name);
    if (device && this.#devices.has(device)) return device;
    for (const group of this.#groups.values()) if (group.friendly_name === name || String(group.id) === name) return groupKey(group.id);
    return null;
  }

  #setTopic(key: string): string {
    const id = groupIdOf(key);
    return id !== null ? TOPIC.groupSet(this.#groups.get(id)?.friendly_name ?? String(id)) : TOPIC.set(key);
  }

  #getTopic(key: string): string {
    const id = groupIdOf(key);
    return id !== null ? TOPIC.groupSet(this.#groups.get(id)?.friendly_name ?? String(id)).replace(/\/set$/, '/get') : TOPIC.get(key);
  }

  #about(key: string): MemberAbout | null {
    const device = this.#devices.get(key);
    if (!device) return null;
    return {
      model: device.definition?.model ?? device.model_id ?? null,
      vendor: device.definition?.vendor ?? null,
      description: device.definition?.description ?? null,
      manufacturer: device.manufacturer ?? null,
      software: device.software_build_id ?? null,
      powerSource: device.power_source ?? null,
      known: device.definition?.source !== 'generated' && device.supported !== false,
    };
  }

  /** Reachable as Zigbee2MQTT says — a group when any member is — unknown when it does not say. */
  #availableOf(key: string): boolean | null {
    const id = groupIdOf(key);
    if (id === null) return this.#available.get(key) ?? null;
    const said = (this.#groups.get(id)?.members ?? []).map((member) => this.#available.get(ieeeKey(member.ieee_address) ?? ''));
    if (said.some((value) => value === true)) return true;
    return said.length && said.every((value) => value === false) ? false : null;
  }

  #groupIdentity(id: number): string | null {
    const coordinator = ieeeKey(this.#info?.coordinator?.ieee_address);
    return coordinator ? identityOf('zigbee-group', `${coordinator}-${id}`) : null;
  }

  async #publish(topic: string, payload: Readonly<Record<string, unknown>>): Promise<void> {
    await this.channel.publish(topic, new TextEncoder().encode(JSON.stringify(payload)));
  }

  #tell(key: string): void {
    for (const linked of this.#links.get(key) ?? []) linked.changed();
    // A device's state moves its groups' too.
    for (const group of this.#groups.values()) {
      if (group.members.some((member) => ieeeKey(member.ieee_address) === key)) for (const linked of this.#links.get(groupKey(group.id)) ?? []) linked.changed();
    }
  }

  #tellAll(): void {
    for (const set of this.#links.values()) for (const linked of set) linked.changed();
  }
}
