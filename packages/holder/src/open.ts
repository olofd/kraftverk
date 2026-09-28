import {
  openChannel,
  validateConfig,
  type Channel,
  type DeviceContext,
  type DeviceEvent,
  type DeviceLogger,
  type DeviceSession,
  type DeviceStore,
  type DeviceType,
  type OpenConnection,
  type Platform,
  type Protocol,
  type SavedDeviceId,
  type TransportSource,
} from '@kraftverk/device-sdk';

/**
 * Opening one device, the same in every holder (docs/ARCHITECTURE.md step 17).
 *
 * The connection's channel through the protocol's binding and guard, the
 * device's context, and its type's session over them — or its simulator, with
 * no connection. What the holder differs in is handed in: where the store,
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
  /** The connection to open; null opens the type's simulator. */
  connection: { method: string; transport: string; address: string; config: Record<string, unknown> } | null;
  secret: (field: string) => string | null;
  protocols: { get(id: string): Protocol | null | undefined };
  transports: TransportSource;
  store: DeviceStore;
  platform: Platform;
  readOnly: boolean;
  allowRawFrames: boolean;
  log: DeviceLogger;
  emit: (event: DeviceEvent) => void;
  /** After each scheduled run: the app redraws what the run changed. */
  afterScheduled?: () => void;
  timeoutMs?: number;
};

export type OpenedDevice = {
  session: DeviceSession;
  /** The channel this holder opened, and so closes; null for a simulator. */
  channel: Channel | null;
  /** Stops its scheduled work, closes its session, then its channel. Never throws. */
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
    Only the fields the type knows. Writes are held to the schema strictly; but
    a device saved by an older version may carry a key its type has since
    dropped, and that must not stop a working device from opening.
  */
  const known = Object.fromEntries(Object.entries(device.config).filter(([field]) => field in type.config.fields));
  const config = validateConfig(type.config, known);
  if (!config.ok) throw new OpenRefused(`Needs setting up: ${config.issues.map((issue) => issue.message).join('; ')}`, 'unconfigured');

  const timers: ReturnType<typeof setInterval>[] = [];
  let channel: Channel | null = null;
  const stop = () => {
    for (const timer of timers.splice(0)) clearInterval(timer);
  };

  try {
    let connection: OpenConnection | null = null;
    if (input.connection) {
      const method = type.connections.find((candidate) => candidate.id === input.connection!.method);
      if (!method) throw new OpenRefused(`${type.meta.name} no longer has a way called "${input.connection.method}"`, 'error');
      channel = await openChannel(input.transports, input.protocols.get(method.protocol), input.connection);
      connection = {
        method: method.id,
        protocol: method.protocol,
        transport: input.connection.transport,
        address: input.connection.address,
        channel,
        config: input.connection.config as OpenConnection['config'],
        secrets: { get: input.secret },
        platform: input.platform,
      };
    }

    const context: DeviceContext = {
      deviceId: device.id,
      config: config.value,
      connection,
      store: input.store,
      log: input.log,
      readOnly: input.readOnly,
      allowRawFrames: input.allowRawFrames,
      platform: input.platform,
      schedule: (everyMs, task) => {
        let running = false;
        timers.push(
          setInterval(() => {
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
      emit: input.emit,
    };

    const session = await withTimeout(
      connection ? type.createSession(context) : type.createSimulator(context),
      `Opening ${device.name}`,
      input.timeoutMs ?? OPEN_TIMEOUT_MS
    );

    const opened = channel;
    return {
      session,
      channel: opened,
      close: async () => {
        stop();
        await withTimeout(session.close(), 'Closing a device', 5_000).catch(() => undefined);
        await opened?.close().catch(() => undefined);
      },
    };
  } catch (error) {
    stop();
    await channel?.close().catch(() => undefined);
    throw error instanceof OpenRefused ? error : new OpenRefused((error as Error).message, 'error');
  }
}
