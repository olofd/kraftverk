import {
  defineDeviceType,
  linkOf,
  type CategoryId,
  type DeviceContext,
  type DeviceSession,
  type DeviceType,
  type Reading,
  type SessionHealth,
  type ToolRun,
  type ToolSpec,
  type Value,
} from '@kraftverk/device-sdk';

import type { ZigbeeLink } from './link.ts';
import { groupKey, ZigbeeNetwork } from './network.ts';
import { playedZigbee2Mqtt } from './played.ts';
import { getPayload, readingsOf, setPayload, shapeOf, SOFTWARE_PROPERTY, updateOf, type BridgeDevice, type Expose, type Shape } from './protocol/index.ts';

/*
  A device behind a Zigbee2MQTT coordinator, of any kind (docs/PLAN-ZIGBEE.md
  §5.3): one implementation, a type per shelf so each lands where a person
  looks for it, each describing itself from what it exposes. Read and
  commanded through its coordinator's link; every command and write through
  the gateway, verified by the state Zigbee2MQTT says back.
*/

type Config = Record<string, never>;

/**
 * How long what a device on batteries last said holds: a sensor reports at
 * least hourly (the SNZB-02P's temperature at most 3600 s apart), so twice
 * that without a word is a device that has stopped.
 */
const BATTERY_CHECK_IN_MS = 2 * 3_600_000;

/** How long a write waits for the device to say it took. */
const READBACK_MS = 5000;

/** One generic type: its shelf, and what it is until the device says — the shape its simulator plays. */
export type ZigbeeTypeSpec = {
  id: string;
  name: string;
  category: CategoryId;
  icon: string;
  description: string;
  /** What a typical one exposes: the type's description until a device says its own, and its simulator. */
  typical: readonly Expose[];
  /** A group, reached by its group number: its simulator plays a group of two of `typical`. */
  group?: boolean;
  /**
   * What a simulated one is, when not a typical one: what it exposes, and
   * how it moves on the simulation's clock — given how to say its values.
   * Returns how to stop.
   */
  simulated?: { exposes: readonly Expose[]; plays?: (say: (values: Record<string, unknown>) => void, clock: DeviceContext<Config>['clock']) => () => void };
};

const THROUGH = 'Zigbee2MQTT is reached through this server’s broker, and its devices through it';

/** Opens the link a session reads through, telling `changed` whenever what it reads moved. */
type Open = (changed: () => void) => Promise<ZigbeeLink>;

/** Its health: the coordinator's first, then what Zigbee2MQTT says of it, then whether it has said anything. */
function healthOf(link: ZigbeeLink, shape: Shape | null): SessionHealth {
  const { at } = link.state();
  if (!link.connected()) return { status: 'offline', detail: 'Its coordinator is not there: Zigbee2MQTT is not running, or not connected', lastReadingAt: at };
  if (!shape) return { status: 'connecting', detail: 'Joining: Zigbee2MQTT is asking it what it is', lastReadingAt: at };
  if (link.available() === false) return { status: 'offline', detail: 'Zigbee2MQTT says it does not answer: is it powered, and in range of a router?', lastReadingAt: at };
  // Reachable, and quiet since this server began listening: a battery device speaks when a value changes, at least hourly.
  if (!at && link.available() === true) return { status: 'connected', detail: 'Reachable; waiting for its next report — it says a value when it changes', lastReadingAt: null };
  if (!at) return { status: 'connecting', detail: 'Waiting for it to say something', lastReadingAt: null };
  const updating = updateOf(link.state().values.update);
  if (updating?.state === 'updating') {
    const left = updating.remaining !== null ? `, about ${Math.max(1, Math.round(updating.remaining / 60))} min left` : '';
    return { status: 'connected', detail: `Updating its firmware: ${Math.round(updating.progress ?? 0)} %${left}`, lastReadingAt: at };
  }
  const about = link.about();
  return { status: 'connected', detail: about ? `${about.vendor ?? ''} ${about.model ?? ''}`.trim() || 'Zigbee' : 'A Zigbee group', lastReadingAt: at };
}

/** The values a write asked for, once the device says them back — or what it says when the wait ends. */
async function readback(link: ZigbeeLink, shape: Shape, keys: readonly string[], since: object): Promise<Record<string, Value>> {
  const deadline = Date.now() + READBACK_MS;
  // Each message it says is a new state: what it said before the write is not its answer.
  while (Date.now() < deadline && link.state().values === since) await new Promise((resolve) => setTimeout(resolve, 20));
  const { values, at } = link.state();
  const readings = readingsOf(shape, values, at ?? new Date().toISOString());
  return Object.fromEntries(keys.map((key) => [key, readings.find((reading) => reading.key === key)?.value ?? null]));
}

/**
 * Updating its firmware (docs/PLAN-ZIGBEE.md §5.7): tools a person runs —
 * confirmed, on the timeline, refused while read-only, never an automation's.
 */
const FIRMWARE_TOOLS = {
  updateFirmware: {
    label: 'Update its firmware',
    description:
      'Installs the newer firmware Zigbee2MQTT’s index offers for it — what it changes is under its readings. 10–100 minutes; it keeps working meanwhile. One device at a time: another waits its turn. One on batteries updates the next time it wakes.',
    answer: { type: 'string' },
    writes: true,
    confirm:
      'Its firmware is replaced. It takes 10–100 minutes and it keeps working meanwhile; if it fails, it keeps the firmware it has. A new firmware can change how it behaves and some of its settings: they are compared afterwards, and a change is said. Leave it plugged in, and Zigbee2MQTT running, until it is done.',
  },
  stopFirmwareUpdate: {
    label: 'Stop updating its firmware',
    description: 'Stops an update under way, or takes one waiting its turn out of line. It keeps the firmware it has.',
    answer: { type: 'string' },
    writes: true,
  },
  checkFirmware: {
    label: 'Check for newer firmware',
    description: 'Asks Zigbee2MQTT’s index now whether a newer firmware is offered for it. Zigbee2MQTT also asks by itself, at most once a day.',
    answer: { type: 'string' },
    writes: false,
  },
} as const satisfies Record<string, ToolSpec>;

function firmwareTools(link: ZigbeeLink, ctx: DeviceContext<Config>): Record<keyof typeof FIRMWARE_TOOLS, ToolRun> {
  const writing = (run: () => Promise<string>) => async () => {
    if (ctx.readOnly) throw new Error('Every hardware write is refused: this holder is read-only');
    return run();
  };
  return {
    updateFirmware: writing(() => link.firmware.update()),
    stopFirmwareUpdate: writing(() => link.firmware.stop()),
    checkFirmware: () => link.firmware.check(),
  };
}

/** A member's session over its link: the same for a real coordinator's and a simulated one's. */
async function sessionOver(open: Open, ctx: DeviceContext<Config>, typical: Shape, close: () => Promise<void>): Promise<DeviceSession> {
  let link: ZigbeeLink | null = null;
  let asked = false;
  /** Nothing of its state is kept by default (§5.6): asked once, as soon as it is known and has said nothing. */
  const ask = () => {
    const shape = link?.shape();
    if (!link || asked || !shape || link.state().at || !link.connected()) return;
    asked = true;
    const payload = getPayload(shape);
    if (payload) void link.get(payload).catch((error: Error) => ctx.log.warn(`Asking it for its state: ${error.message}`));
  };
  link = await open(() => {
    for (const event of link?.takeEvents() ?? []) ctx.event(event.id, event.data);
    ask();
    ctx.changed();
  });
  const it = link;
  ask();

  /** Writes settings: only for a device that has any — a sensor does not say it can. */
  const write = async (patch: Readonly<Record<string, Value>>) => {
    const shape = it.shape();
    if (!shape) throw new Error('It is still joining: nothing can be written yet');
    if (ctx.readOnly) throw new Error('Every hardware write is refused: this holder is read-only');
    const built = setPayload(shape, patch);
    if ('error' in built) throw new Error(built.error);
    const since = it.state().values;
    await it.set(built.payload);
    return readback(it, shape, Object.keys(patch), since);
  };
  const writes = (it.shape() ?? typical).fields.some((field) => field.settable && field.spec.access === 'write');

  return {
    health: () => healthOf(it, it.shape()),
    readings: (): Reading[] => {
      const shape = it.shape();
      const { values, at } = it.state();
      if (!shape || !at) return [];
      /*
        A Zigbee device says a value when it changes — beyond its reportable
        change — and otherwise at most once in a while: a sensor at 24 °C says
        nothing for an hour. While Zigbee2MQTT says it is reachable, what it
        last said still holds, so it is current from now (`confirmedAt`); when
        Zigbee2MQTT does not say, its age alone decides. Zigbee2MQTT says a
        device on batteries is reachable for a day after it last spoke, and a
        sensor whose battery died would say 21 °C all that day: one on
        batteries holds only while it has spoken within its check-in time.
      */
      const now = ctx.clock.now();
      const battery = /battery/i.test(it.about()?.powerSource ?? '');
      const holds = it.connected() && it.available() === true && (!battery || now - Date.parse(at) <= BATTERY_CHECK_IN_MS);
      const confirmedAt = holds ? new Date(now).toISOString() : null;
      // The build it runs is in Zigbee2MQTT's device list, not in its state: read with the rest, as its firmware.
      const software = it.about()?.software ?? null;
      const said = software ? { ...values, [SOFTWARE_PROPERTY]: software } : values;
      return readingsOf(shape, said, at).map((reading) => (confirmedAt && confirmedAt > reading.at ? { ...reading, confirmedAt } : reading));
    },
    description: () => it.shape()?.description ?? null,
    info: () => {
      const about = it.about();
      return about ? { ...(about.vendor ? { manufacturer: about.vendor } : {}), ...(about.model ? { model: about.model } : {}), ...(about.software ? { firmware: { main: about.software } } : {}) } : null;
    },
    identity: () => ({ id: it.identity(), name: null }),

    async command(request) {
      const shape = it.shape();
      const field = shape?.switches.get(request.part);
      if (!shape || !field || request.capability !== 'switch' || request.command !== 'set' || typeof request.args.on !== 'boolean') {
        return { accepted: false, error: `It takes no ${request.capability}.${request.command} on ${request.part}` };
      }
      if (ctx.readOnly) return { accepted: false, error: 'Every hardware write is refused: this holder is read-only' };
      try {
        await it.set({ [field.property]: field.write(request.args.on) });
        return { accepted: true };
      } catch (error) {
        return { accepted: false, error: (error as Error).message };
      }
    },

    ...(writes ? { write } : {}),

    // Its firmware's tools, where Zigbee2MQTT can update it: known once it has said what it is.
    get tools() {
      return it.about()?.ota ? firmwareTools(it, ctx) : undefined;
    },

    close: async () => {
      it.close();
      await close();
    },
  };
}

/** A coordinator in memory with one member of this type — two in a group, for a group — and how to link to it: what a simulated one is. */
function simulated(spec: ZigbeeTypeSpec, ctx: DeviceContext<Config>): { open: Open; stop: () => void } {
  const ieee = (n: number) => `0x00124b00000000${(0xc0 + n).toString(16)}`;
  const member = (n: number): BridgeDevice => ({
    ieee_address: ieee(n),
    type: 'Router',
    friendly_name: ieee(n),
    supported: true,
    interview_state: 'SUCCESSFUL',
    definition: { model: 'SIMULATED', vendor: 'Simulated', description: spec.name, source: 'native', exposes: spec.simulated?.exposes ?? spec.typical },
  });
  const played = playedZigbee2Mqtt({
    devices: spec.group ? [member(1), member(2)] : [member(1)],
    groups: spec.group ? [{ id: 1, friendly_name: 'Simulated group', members: [{ ieee_address: ieee(1), endpoint: 1 }, { ieee_address: ieee(2), endpoint: 1 }] }] : [],
    now: () => ctx.clock.now(),
  });
  const network = new ZigbeeNetwork(played.channel, { changed: () => {}, log: () => {}, now: () => ctx.clock.now() });
  network.start();
  const stopPlaying = spec.simulated?.plays?.((values) => played.say(ieee(1).slice(2), values), ctx.clock) ?? (() => {});
  return {
    open: async (changed) => {
      // What it keeps arrives a moment after subscribing, as from a broker: its member is known then.
      for (let tries = 0; tries < 50 && !network.members().length; tries++) await new Promise((resolve) => setTimeout(resolve, 10));
      return network.link(spec.group ? groupKey(1) : ieee(1).slice(2), changed);
    },
    stop: () => {
      stopPlaying();
      network.close();
      played.stop();
    },
  };
}

/** One generic Zigbee type: its shelf, its way through the coordinator, and the one session every Zigbee device has. */
export function defineZigbeeType(spec: ZigbeeTypeSpec): DeviceType<Config> {
  const typicalShape = shapeOf(spec.typical);
  const typical = typicalShape.description;
  return defineDeviceType<Config>({
    id: spec.id,
    kind: 'hardware',
    meta: {
      name: spec.name,
      category: spec.category,
      icon: spec.icon,
      description: spec.description,
      support: 'experimental',
      supportNote: 'Describes itself from what Zigbee2MQTT says it exposes; tested against a played Zigbee2MQTT until the dongle is up.',
    },
    config: { fields: {} },
    describe: () => typical,
    // A group has no firmware of its own; a device does where Zigbee2MQTT can update it (its session says).
    ...(spec.group ? {} : { tools: FIRMWARE_TOOLS }),
    connections: [
      {
        id: 'zigbee',
        label: 'Through Zigbee2MQTT',
        description: spec.group
          ? 'A group made on the coordinator: its devices take one command together.'
          : 'Paired with the Zigbee dongle on this server, through Zigbee2MQTT: let it join on the coordinator’s page, and add it from there.',
        through: ['zigbee2mqtt.bridge'],
        reach: 'local',
        updates: 'push',
      },
    ],

    /** Reads what Zigbee2MQTT says of it: what it is, what it exposes, and whether it answers. */
    async identify(connection) {
      const link = await linkOf<ZigbeeLink>(connection, () => {}, THROUGH);
      try {
        for (let tries = 0; tries < 30 && !link.shape(); tries++) await new Promise((resolve) => setTimeout(resolve, 100));
        if (!link.connected()) throw new Error('Its coordinator is not there: Zigbee2MQTT is not running, or not connected');
        const shape = link.shape();
        if (!shape) throw new Error('It is still joining: Zigbee2MQTT is asking it what it is. Try again in a moment.');
        const about = link.about();
        const what = about ? `${about.vendor ?? ''} ${about.description ?? about.model ?? ''}`.trim() : 'A Zigbee group';
        const reachable = link.available() === false ? ' Zigbee2MQTT says it does not answer now.' : '';
        return {
          identity: link.identity(),
          model: about?.model ?? null,
          summary: `${what}, through Zigbee2MQTT${about && !about.known ? ' — guessed from what it said, not known by Zigbee2MQTT' : ''}.${reachable}`,
          description: shape.description,
          ...(about ? { info: { ...(about.vendor ? { manufacturer: about.vendor } : {}), ...(about.model ? { model: about.model } : {}) } } : {}),
        };
      } finally {
        link.close();
      }
    },

    createSession: (ctx) => sessionOver((changed) => linkOf<ZigbeeLink>(ctx.connection, changed, THROUGH), ctx, typicalShape, async () => undefined),

    createSimulator: (ctx) => {
      const { open, stop } = simulated(spec, ctx);
      return sessionOver(open, ctx, typicalShape, async () => stop());
    },
  });
}
