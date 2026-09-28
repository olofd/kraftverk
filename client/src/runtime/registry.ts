import { Platform } from 'react-native';

import type {
  Availability,
  DeviceType,
  Protocol,
  Transport,
  TransportContext,
  TransportDefinition,
  TransportFactory,
} from '@kraftverk/device-sdk';

import { DEVICE_TYPES, PROTOCOLS, TRANSPORTS } from '../generated/registry';

/**
 * What this app has installed, and the transports it can use where it runs.
 *
 * The same device types, protocols and transports the server finds at start,
 * bound into the app by `npm run gen:devices` because a store build cannot load
 * code. A transport runs here when it has an implementation for this platform
 * — Web Bluetooth in a browser, the phone's radio in the app — and is started
 * the first time something needs it, once.
 */

export type AppPlatform = 'web' | 'native';

export const PLATFORM: AppPlatform = Platform.OS === 'web' ? 'web' : 'native';

type Entry = { definition: TransportDefinition; factory: TransportFactory | null; transport: Transport | null; starting: Promise<Transport | null> | null; error: string | null };

export class AppRegistry {
  readonly types = new Map<string, DeviceType<any>>(DEVICE_TYPES.map((type) => [type.id, type]));
  readonly protocols = new Map<string, Protocol>(PROTOCOLS.map((protocol) => [protocol.id, protocol]));
  #transports = new Map<string, Entry>(
    TRANSPORTS.map((entry) => [entry.definition.id, { definition: entry.definition, factory: entry[PLATFORM], transport: null, starting: null, error: null }])
  );

  constructor(private context: TransportContext) {}

  definition(id: string): TransportDefinition | null {
    return this.#transports.get(id)?.definition ?? null;
  }

  /** The ids of transports this app can hold a connection over, here. */
  held(): string[] {
    return [...this.#transports.values()].filter((entry) => entry.factory && entry.definition.platforms.includes(PLATFORM)).map((entry) => entry.definition.id);
  }

  /** Whether this app can hold a connection over a transport, and if not, why. */
  available(id: string): Availability {
    const entry = this.#transports.get(id);
    if (!entry) return { ok: false, reason: 'This app cannot reach devices this way: update it' };
    if (!entry.factory || !entry.definition.platforms.includes(PLATFORM)) {
      return { ok: false, reason: `${capitalise(entry.definition.label)} is not available ${PLATFORM === 'web' ? 'in a browser' : 'in this app'}` };
    }
    if (entry.error) return { ok: false, reason: entry.error };
    // Not started yet: a probe that needs nothing started, like "is there Web Bluetooth here".
    if (!entry.transport) return entry.factory(this.context).available();
    return entry.transport.available();
  }

  /** Starts a transport, once. Null when it cannot run here; never throws. */
  async start(id: string): Promise<Transport | null> {
    const entry = this.#transports.get(id);
    if (!entry?.factory) return null;
    if (entry.transport) return entry.transport;
    entry.starting ??= (async () => {
      try {
        const transport = entry.factory!(this.context);
        await transport.start();
        entry.transport = transport;
        entry.error = null;
        return transport;
      } catch (error) {
        entry.error = (error as Error).message;
        this.context.log('warn', `[transports] ${id} could not start: ${entry.error}`);
        return null;
      } finally {
        entry.starting = null;
      }
    })();
    return entry.starting;
  }

  async stopAll(): Promise<void> {
    await Promise.all(
      [...this.#transports.values()].map(async (entry) => {
        const transport = entry.transport;
        entry.transport = null;
        await transport?.stop().catch(() => undefined);
      })
    );
  }
}

const capitalise = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
