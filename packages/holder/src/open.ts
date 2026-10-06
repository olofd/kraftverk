import {
  checkValue,
  closingOnce,
  isBridgedMethod,
  isSimulated,
  openChannel,
  REAL_CLOCK,
  SIMULATED_TRANSPORT,
  simulatedMethodOf,
  validateConfig,
  type Bridge,
  type Channel,
  type Clock,
  type ClockTimer,
  type ConnectionHealth,
  type DeviceContext,
  type DescriptionSource,
  type DeviceDescription,
  type DeviceInfo,
  type DeviceLogger,
  type DeviceSession,
  type DeviceStore,
  type DeviceType,
  type MemberLink,
  type OpenConnection,
  type NodeId,
  type Platform,
  type Protocol,
  type SavedDeviceId,
  type Simulation,
  type TransportSource,
} from '@kraftverk/device-sdk';

import type { DeviceEventMessage } from './bus.ts';

/**
 * Opening one device, the same in every holder (docs/ARCHITECTURE.md step 17).
 *
 * The connection's channel through the protocol's binding and guard — or,
 * through a bridge, the link its bridge hands it — the device's context, and
 * its type's session over them; or its simulator, with no connection. What the holder differs in is handed in: where the store,
 * secrets, log and audit go, which transports it has, and where it runs.
 */

/** How long a type may take to open a session before it counts as not answering. */
export const OPEN_TIMEOUT_MS = 10_000;

/** Why a device could not be opened, with whether the person has something to set up. */
export class OpenRefused extends Error {
  constructor(
    message: string,
    readonly status: 'unconfigured' | 'error'
  ) {
    super(message);
  }
}

export type OpenInput = {
  type: DeviceType<any>;
  device: { id: SavedDeviceId; name: string; config: Record<string, unknown> };
  /** The connection to open; null, or a simulated one, opens the type's simulator. */
  connection: { method: string; transport: string; address: string; config: Record<string, unknown> } | null;
  /** For a connection through a bridge: the bridge's open session, which hands it its link. Null when it is not open here. */
  bridge?: Bridge | null;
  secret: (field: string) => string | null;
  protocols: { get(id: string): Protocol | null | undefined };
  transports: TransportSource;
  store: DeviceStore;
  platform: Platform;
  /** The node opening it: what its health names as holding it. */
  node: NodeId;
  readOnly: boolean;
  allowRawFrames: boolean;
  log: DeviceLogger;
  /** After each scheduled run: the app redraws what the run changed. */
  afterScheduled?: () => void;
  /** A device that pushes said something changed: a reading, its description, its information. */
  changed?: () => void;
  /** An event the device raised, already checked against its description. */
  event?: (event: DeviceEventMessage) => void;
  /**
   * For a simulator: whether what feeds one of its parts gives it power now —
   * a simulated switch linked to it as `feeds` — or null when nothing
   * simulated does. Who knows the links answers; without it, nothing feeds.
   */
  fed?: (part: string) => boolean | null;
  /** The home's time: its context's clock, which its scheduled work keeps. Real time when not given. */
  clock?: Clock;
  timeoutMs?: number;
};

export type OpenedDevice = {
  session: DeviceSession;
  /** What the device is now: its own description when it reports one, else its type's for its config. */
  description(): DeviceDescription;
  /** Whose word that is: the type's, for its config, or the device's own. */
  describedBy(): DescriptionSource;
  /** What the device has said about itself, as far as it has. */
  info(): DeviceInfo | null;
  /** How it is doing: its session's word, and who holds it over what — which only the holder knows. */
  health(): ConnectionHealth;
  /** The channel this holder opened, and so closes; null for a simulator, and through a bridge. */
  channel: Channel | null;
  /** Stops its scheduled work, closes its session, then its channel or its link. Never throws. */
  close(): Promise<void>;
};

/**
 * Bounds how long something may take, so one device that never answers cannot
 * hold up everything that waits for it.
 */
export function withTimeout<T>(promise: Promise<T>, what: string, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} took longer than ${Math.round(ms / 1000)} s`)), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/**
 * Opens a device. Throws `OpenRefused` with a sentence for its card when it
 * cannot, having closed whatever it had opened on the way.
 */
export async function openDevice(input: OpenInput): Promise<OpenedDevice> {
  const { type, device } = input;

  /*
    Held to its type's schema, strictly (strict version 1, AGENTS.md): a key
    the type does not have means the device was saved against another shape
    of it, and saying so is better than opening it on a guess.
  */
  const unknown = Object.keys(device.config).filter((field) => !(field in type.config.fields));
  if (unknown.length) throw new OpenRefused(`Needs setting up again: ${type.meta.name} has no setting ${unknown.map((field) => `"${field}"`).join(', ')}`, 'unconfigured');
  const config = validateConfig(type.config, device.config);
  if (!config.ok) throw new OpenRefused(`Needs setting up: ${config.issues.map((issue) => issue.message).join('; ')}`, 'unconfigured');

  const clock = input.clock ?? REAL_CLOCK;
  const timers: ClockTimer[] = [];
  let channel: Channel | null = null;
  // Every link a session or its check makes through a bridge: let go of when the device closes, whatever the session did.
  const links: MemberLink[] = [];
  const letGo = () => {
    for (const link of links.splice(0)) link.close();
  };
  const stop = () => {
    for (const timer of timers.splice(0)) clock.clear(timer);
  };

  try {
    let connection: OpenConnection | null = null;
    // Simulated is a way to add any device, not one of its type's methods: it opens the simulator and reaches nothing.
    if (input.connection && !isSimulated(input.connection)) {
      const method = type.connections.find((candidate) => candidate.id === input.connection!.method);
      if (!method) throw new OpenRefused(`${type.meta.name} no longer has a way called "${input.connection.method}"`, 'error');
      const config = input.connection.config as OpenConnection['config'];
      if (isBridgedMethod(method)) {
        // Through a bridge: its session links to the member through it, and is told through the link when what it reads has moved.
        const bridge = input.bridge;
        if (!bridge) throw new OpenRefused(`${device.name} is reached through a bridge that is not open here`, 'error');
        const address = input.connection.address;
        connection = {
          kind: 'bridged',
          method: method.id,
          address,
          config,
          platform: input.platform,
          link: async (changed) => {
            const link = closingOnce(await bridge.link(address, changed));
            links.push(link);
            return link;
          },
        };
      } else {
        channel = await openChannel(input.transports, input.protocols.get(method.protocol), input.connection);
        connection = {
          kind: 'direct',
          method: method.id,
          protocol: method.protocol,
          transport: input.connection.transport,
          address: input.connection.address,
          channel,
          config,
          secrets: { get: input.secret },
          platform: input.platform,
        };
      }
    }

    // Declared once for this device's config; a device that reports its own replaces it.
    const declared = type.describe(config.value);
    let session: DeviceSession | null = null;
    const describe = (): DeviceDescription => session?.description?.() ?? declared;

    // A simulator's world: what it was set up with, by its simulated way's own choices, and what feeds it.
    let simulation: Simulation | null = null;
    if (!connection) {
      const setUp = validateConfig(simulatedMethodOf(type).config ?? { fields: {} }, input.connection?.config ?? {});
      if (!setUp.ok) throw new OpenRefused(`Needs setting up: ${setUp.issues.map((issue) => issue.message).join('; ')}`, 'unconfigured');
      simulation = { config: setUp.value, fed: (part) => input.fed?.(part) ?? null };
    }

    const context: DeviceContext = {
      deviceId: device.id,
      config: config.value,
      connection,
      simulation,
      clock,
      store: input.store,
      log: input.log,
      readOnly: input.readOnly,
      allowRawFrames: input.allowRawFrames,
      platform: input.platform,
      schedule: (everyMs, task) => {
        let running = false;
        timers.push(
          clock.setInterval(() => {
            // Skipped, not queued: a device that stops answering must not
            // build a backlog of polls that all fire when it comes back.
            if (running) return;
            running = true;
            void Promise.resolve()
              .then(task)
              .catch((error: unknown) => input.log.warn(`scheduled work failed: ${(error as Error).message}`))
              .finally(() => {
                running = false;
                input.afterScheduled?.();
              });
          }, everyMs)
        );
      },
      changed: () => input.changed?.(),
      event: (id, data, part) => {
        const spec = describe().events?.find((candidate) => candidate.id === id);
        if (!spec) {
          input.log.warn(`raised an event it does not declare: "${id}"`);
          return;
        }
        const wrong = Object.entries(data ?? {}).find(([field, value]) => {
          const type = spec.data?.[field];
          return !type || (value !== null && !checkValue(type, value).ok);
        });
        if (wrong) {
          input.log.warn(`raised "${id}" with "${wrong[0]}", which it does not declare as that`);
          return;
        }
        input.event?.({ id, level: spec.level, part: part ?? spec.part ?? null, data: data ?? null, at: new Date(clock.now()).toISOString() });
      },
    };

    const opened = await withTimeout(
      connection ? type.createSession(context) : type.createSimulator(context),
      `Opening ${device.name}`,
      input.timeoutMs ?? OPEN_TIMEOUT_MS
    );
    session = opened;

    const openChannelRef = channel;
    return {
      session: opened,
      description: describe,
      describedBy: () => (opened.description ? 'device' : 'type'),
      info: () => opened.info?.() ?? null,
      health: () => ({
        ...opened.health(),
        node: input.node,
        transport: input.connection?.transport ?? SIMULATED_TRANSPORT,
      }),
      channel: openChannelRef,
      close: async () => {
        stop();
        await withTimeout(opened.close(), 'Closing a device', 5_000).catch(() => undefined);
        await openChannelRef?.close().catch(() => undefined);
        letGo();
      },
    };
  } catch (error) {
    stop();
    await channel?.close().catch(() => undefined);
    letGo();
    throw error instanceof OpenRefused ? error : new OpenRefused((error as Error).message, 'error');
  }
}
