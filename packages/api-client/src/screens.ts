import type { Value } from '@kraftverk/device-sdk';
import type { GatewayResult, WriteResult } from '@kraftverk/gateway';

import type { DeviceView, VersionInfo } from './types';

/**
 * What the app hands a device type's own screens (docs/ARCHITECTURE.md §3, a
 * device type's `ui/`).
 *
 * A screen draws one device; it never learns who holds its connection. The
 * app gives it the device as the server describes it, and actions that reach
 * the device through whoever holds the connection in use — the server, over
 * HTTP, or this app's own session over its own radio. The same screen then
 * works for a station on the server's Wi-Fi and one on this browser's Bluetooth,
 * and never imports the app that renders it.
 */

/** A command to one part of the device: `switch.set({ on: false })` on `outlet.ac`. */
export type CommandInput = {
  part: string;
  capability: string;
  command: string;
  args: Record<string, Value>;
  reason?: string;
};

export type DeviceActions = {
  /** Runs one of the type's own tools (`DeviceView.advanced`). */
  tool<T = unknown>(name: string, input?: Record<string, unknown>): Promise<T>;
  /**
   * Writes attributes the device remembers — its settings — through the
   * holder's gateway. When a person has to confirm, the app asks them and
   * sends it again; the result is the gateway's final word.
   */
  write(patch: Record<string, Value>): Promise<WriteResult>;
  /**
   * A capability command, through the holder's gateway. When a person has to
   * confirm it, the app asks them — saying why — and sends it again; the
   * result is the gateway's final word.
   */
  command(input: CommandInput): Promise<GatewayResult>;
  /**
   * A read-only diagnostic of the transport under the connection in use — the
   * broker's journal — or null when the holder has none to show.
   */
  diagnostic: (<T = unknown>(name: string, query?: Record<string, string | number>) => Promise<T>) | null;
};

export type DeviceScreenProps = {
  device: DeviceView;
  actions: DeviceActions;
  /** Who holds the connection in use: the server, this app, another app, or nobody right now. */
  holder: 'server' | 'this-app' | 'other-app' | 'none';
  /** Every write is refused by whoever holds the connection. */
  readOnly: boolean;
  /** The server, when there is one in the path. */
  version: VersionInfo | null;
};
