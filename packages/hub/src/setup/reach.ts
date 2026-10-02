import type { CheckOutcome } from '@kraftverk/api-contract';
import { openChannel, type Channel, type ConfigValues, type Identified, type OpenConnection, type Protocol, type TransportDefinition } from '@kraftverk/device-sdk';
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

/** A device, over its protocol and one of this home's transports. */
export function overHardware(protocol: Protocol | null, transport: TransportDefinition | null, transports: TransportHost): Reach {
  return {
    protocol,
    transport,
    exclusive: transport?.exclusive !== false,
    strict: true,
    /** Opened, asked who it is by its type's `identify`, and let go. */
    async identify(draft) {
      const method = draft.method!;
      let channel: Channel | null = null;
      try {
        channel = await openChannel(transports, protocol, { transport: method.transport, address: draft.address! });
        const connection: OpenConnection = {
          method: method.id,
          protocol: method.protocol,
          transport: method.transport,
          address: draft.address!,
          channel,
          config: draft.connection as ConfigValues,
          secrets: { get: (field) => draft.secrets.get(field) ?? null },
          platform: transports.platform,
        };
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
        await channel?.close().catch(() => undefined);
      }
    },
  };
}
