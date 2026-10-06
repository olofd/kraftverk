import type { AutomationId, ConnectionHealth, DeviceKind, EventLevel, IntegrationInfo, Reading, SavedDeviceId, Value } from '@kraftverk/device-sdk';

import type { FoundView } from './setup.ts';

/*
  What a home says as it happens: the live stream's updates, what devices
  said happened, the problems across them, and what a screen reports it
  shows, so what it shows is kept fresh.
*/

/** Something a device said happened, as it is kept: `GET /devices/:id/events`, newest first. */
export type DeviceEventView = {
  id: number;
  deviceId: SavedDeviceId;
  part: string;
  /** The event's id, as its description declares it: `mains.lost`. */
  event: string;
  level: EventLevel;
  data: Readonly<Record<string, Value>> | null;
  at: string;
};

/** `GET /problems`: warnings and errors across the devices you have, newest first, each with its device's name. */
export type ProblemView = DeviceEventView & { deviceName: string };

/**
 * One thing that waits on a person (docs/PLAN-INTEGRATIONS.md step 8): a
 * device or an account that needs signing in to again — its own, not one
 * that only waits on the bridge it is behind — or a device behind one of
 * your accounts or gateways, found and not added yet. Each says what opens
 * it: the page that fixes it.
 */
export type NeedsYouView =
  | {
      kind: 'act';
      device: { id: SavedDeviceId; name: string; kind: DeviceKind; integration: IntegrationInfo | null };
      /** What it needs, in its own words: "The service did not accept that password: sign in again on its page". */
      detail: string;
    }
  | { kind: 'found'; found: FoundView };

/** Something a device said happened, as the live stream carries it. */
export type LiveEvent = {
  id: string;
  level: EventLevel;
  part: string | null;
  data: Readonly<Record<string, Value>> | null;
  at: string;
};

/**
 * `GET /api/live`, a WebSocket: what changed, as it changes, server to app.
 *
 * The app reads the list (`GET /devices`) when the socket opens, and applies
 * these on top: readings merged by key, health replaced. `changed` asks it to
 * read the list again — something it does not carry in detail changed: a
 * device added, renamed or removed, a connection, a link, what a device is.
 * When the socket is down the app polls, as it did before there was one.
 */
export type LiveUpdate =
  | { type: 'hello'; at: string }
  /** Only the readings whose values moved. */
  | { type: 'readings'; deviceId: SavedDeviceId; readings: Reading[] }
  | { type: 'health'; deviceId: SavedDeviceId; health: ConnectionHealth }
  | { type: 'event'; deviceId: SavedDeviceId; event: LiveEvent }
  | { type: 'changed'; deviceId: SavedDeviceId | null }
  /** An automation moved: a run started, took a step, or ended. Read it again. */
  | { type: 'automation'; id: AutomationId };

/** Something a screen shows: a device, an automation. More kinds as screens show more. */
export type ShownThing = { kind: 'device'; id: SavedDeviceId } | { kind: 'automation'; id: AutomationId };

/**
 * What an app says over `GET /api/live`, app to server: what it shows now.
 *
 * A fact, not a request — the server judges what follows from it: a device
 * someone is looking at is read more often. Said when the screen changes,
 * again each time the stream opens, and at most once a minute while someone
 * uses the app; an app that says nothing for ten minutes is taken for
 * unattended. `screen` names the screen (`device`, `home`), not the address.
 */
export type ViewReport = { type: 'view'; screen: string; showing: ShownThing[] };

/** Whether a live stream is up: opening, open (it said hello), or down — and opened again by whoever carries it. */
export type LiveState = 'connecting' | 'live' | 'down';

/** A listener of the live stream: what it says its screen shows, and letting go. */
export type LiveStream = {
  /** What its screen shows now: a fact, not a request. */
  say(view: ViewReport): void;
  close(): void;
};
