import type { ComponentType } from 'react';

import type { IntegrationInfo, Part, Value } from '@kraftverk/device-sdk';
import type { GatewayResult, WriteResult } from '@kraftverk/gateway';

import type { DeviceView, LinkView, VersionInfo } from '@kraftverk/api-contract';

/**
 * What the app hands a device type's own screens (docs/ARCHITECTURE.md §3, a
 * device type's `ui/`).
 *
 * A screen draws one device; it never learns who holds its connection. The
 * app gives it the device as the home describes it, and actions that reach
 * the device through whichever node holds the connection in use — a server,
 * over HTTP, or this app's own session over its own radio. The same screen then
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
  /**
   * Runs one of the type's own tools (`DeviceView.tools`). Whoever holds the
   * device checks the input against what the tool asks for and the answer
   * against what it declares, so `T` is the declared answer's shape.
   */
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

/**
 * Whether the device can be reached through `actions` now — never who holds
 * it, which a screen has no business knowing: the same screen draws a device
 * the server holds, one this app holds over its own radio, and one another
 * phone has.
 */
export type DeviceReach = {
  /** Commands, writes and tools reach the device now. */
  now: boolean;
  /** What is awaited while they do not, or before it has said anything: "Waiting for the server…". */
  waiting: string;
  /** How the connection in use is described: "Wi-Fi, through the server". Null when none is in use. */
  via: string | null;
};

export type DeviceScreenProps = {
  device: DeviceView;
  actions: DeviceActions;
  reach: DeviceReach;
  /** Every write is refused by whoever holds the connection. */
  readOnly: boolean;
  /** The server holding it, when a server does. */
  version: VersionInfo | null;
};

/** What a package's card for one part is handed: the device, as every screen gets it, and the part. */
export type PartSlotProps = DeviceScreenProps & { part: Part };

/**
 * Which pieces of a device's pages its package draws itself (step 28's slots).
 * Each is optional, and whatever a package leaves out the app draws from the
 * description: a package deepens one part of a page and inherits the rest,
 * rather than replacing whole pages.
 */
export type DeviceUi = {
  /**
   * The dashboard's top — in place of the generic overview, energy flow,
   * controls and part cards. History and events stay the app's, drawn for
   * every device alike.
   */
  dashboard?: ComponentType<DeviceScreenProps>;
  /** One part's card on the generic dashboard, by the part's id or its kind: a pack drawn its own way. */
  parts?: Readonly<Record<string, ComponentType<PartSlotProps>>>;
  /** The settings, in place of the generic forms. Connections, links and removing it stay the app's. */
  settings?: ComponentType<DeviceScreenProps>;
  /**
   * A workbench of the type's own above its tools — a register dump with a
   * diff. The tools themselves are drawn from their declarations for every
   * device; this is polish on top.
   */
  tools?: { label: string; description: string; Screen: ComponentType<DeviceScreenProps> };
};

/** What an integration's own piece of its page is handed: the integration, and the accounts you have on it. */
export type IntegrationScreenProps = { integration: IntegrationInfo; accounts: readonly DeviceView[] };

/**
 * Which pieces of its pages an integration draws itself
 * (docs/PLAN-INTEGRATIONS.md §1.1): its page, and an account's, beside what
 * the app draws for every integration — where it runs, its accounts and
 * signing in to them, the devices on it. A device's pages stay its type's.
 */
export type IntegrationUi = {
  /** On its page, below its accounts: what only this platform has to say. */
  page?: ComponentType<IntegrationScreenProps>;
  /** On an account's page, above what is reached through it: the account's own panel. */
  account?: ComponentType<DeviceScreenProps>;
};

const endName = (link: LinkView) => (link.other.partLabel ? `${link.other.name} — ${link.other.partLabel}` : link.other.name);

/** What feeds each of a device's parts, by the part's id, from the links it is the target of: what a screen says of the house. */
export const fedBy = (links: readonly LinkView[]): Record<string, string> => Object.fromEntries(links.filter((link) => link.role === 'target').map((link) => [link.part, endName(link)]));

/** What each of a device's parts feeds, by the part's id, from the links it is the source of. */
export const feedsTo = (links: readonly LinkView[]): Record<string, string> => Object.fromEntries(links.filter((link) => link.role === 'source').map((link) => [link.part, endName(link)]));
