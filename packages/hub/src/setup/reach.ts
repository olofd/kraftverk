import type { CheckOutcome } from '@kraftverk/api-contract';
import {
  closingOnce,
  isBridgedMethod,
  openChannel,
  transportOf,
  type Bridge,
  type ConfigValues,
  type Identified,
  type MemberLink,
  type OpenConnection,
  type Platform,
  type Protocol,
  type SavedDeviceId,
  type TransportDefinition,
} from '@kraftverk/device-sdk';
import { withTimeout } from '@kraftverk/holder';

import type { TransportHost } from '../installed/transports.ts';
import type { Draft } from './draft.ts';

/**
 * How a draft reaches what it sets up — every difference between adding a
 * real device and adding a simulated one, in one place rather than a flag
 * tested in each step.
 */

const CHECK_TIMEOUT_MS = 20_000;

export type Reach = {
  /** The protocol and transport it goes over; none for a simulator. */
  protocol: Protocol | null;
  transport: TransportDefinition | null;
  /** Its address belongs to one device: two you have cannot share it. */
  exclusive: boolean;
  /** A connection's required fields — a device id, a key — must be given. A simulator reaches nothing, and needs neither; what is given is still checked. */
  strict: boolean;
  /** Reads the device once: what it says about itself, or what the check comes to without it. */
  identify(draft: Draft): Promise<{ identified: Identified } | { outcome: CheckOutcome }>;
};

/** Simulated: no transport is started and no device is read; its type's simulator stands in. */
export const SIMULATED_REACH: Reach = {
  protocol: null,
  transport: null,
  exclusive: false,
  strict: false,
  identify: async () => ({ outcome: { outcome: 'new', summary: 'Simulated: no hardware was read, and none will be.', identity: null } }),
};

/** Opens the way to a draft's device, reads who it is with its type's `identify`, and lets go: the check, however it is reached. */
async function readOnce(draft: Draft, open: (linked: <T extends MemberLink>(link: Promise<T>) => Promise<T>) => Promise<OpenConnection>): Promise<{ identified: Identified } | { outcome: CheckOutcome }> {
  let connection: OpenConnection | null = null;
  // What the check links to through a bridge, let go of when it is done.
  const links: MemberLink[] = [];
  const linked = async <T extends MemberLink>(link: Promise<T>): Promise<T> => {
    const made = closingOnce(await link);
    links.push(made);
    return made;
  };
  try {
    connection = await open(linked);
    const quiet = { info: () => {}, warn: (m: string) => console.warn(`[setup] ${m}`), error: (m: string) => console.error(`[setup] ${m}`) };
    const identified = await withTimeout(
      draft.type.identify(connection, { config: draft.device as ConfigValues, log: quiet, signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) }),
      `Reading the ${draft.type.meta.name}`,
      CHECK_TIMEOUT_MS
    );
    return { identified };
  } catch (error) {
    return { outcome: { outcome: 'no-answer', summary: (error as Error).message, saveAnyway: draft.type.setup?.saveAnyway ?? null } };
  } finally {
    if (connection?.kind === 'direct') await connection.channel.close().catch(() => undefined);
    for (const link of links) link.close();
  }
}

/** A device, over its protocol and one of this home's transports. */
export function overHardware(protocol: Protocol | null, transport: TransportDefinition | null, transports: TransportHost): Reach {
  return {
    protocol,
    transport,
    exclusive: transport?.exclusive !== false,
    strict: true,
    identify: (draft) =>
      readOnce(draft, async () => {
        const method = draft.method!;
        if (isBridgedMethod(method)) throw new Error('This way goes through a bridge');
        const channel = await openChannel(transports, protocol, { transport: method.transport, address: draft.address!, config: draft.connection });
        return {
          kind: 'direct',
          method: method.id,
          protocol: method.protocol,
          transport: transportOf(method),
          address: draft.address!,
          channel,
          config: draft.connection as ConfigValues,
          // What it keeps while it is read — a sign-in token — is kept with what the person gave, and saved with it.
          secrets: {
            get: (field) => draft.secrets.get(field) ?? null,
            set: (field, value) => void (value === null ? draft.secrets.delete(field) : draft.secrets.set(field, value)),
          },
          platform: transports.platform,
        };
      }),
  };
}

/**
 * A member of a bridge, read through the link the bridge's open session
 * hands it (docs/PLAN-INTEGRATIONS.md §4.3). Its key is one member of one
 * bridge: two devices you have cannot share it.
 */
export function throughBridge(bridge: (id: SavedDeviceId) => Bridge | null, platform: Platform): Reach {
  return {
    protocol: null,
    transport: null,
    exclusive: true,
    strict: true,
    identify: (draft) =>
      readOnce(draft, async (linked) => {
        const host = draft.through ? bridge(draft.through) : null;
        if (!host) throw new Error('What it is reached through is not open here');
        return { kind: 'bridged', method: draft.method!.id, address: draft.address!, config: draft.connection as ConfigValues, platform, link: (changed) => linked(host.link(draft.address!, changed)) };
      }),
  };
}
