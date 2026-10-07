import { ApiError, type Caller, type ChangesQuery, type DeviceTypeListing, type HistoryQuery, type KraftverkApi } from '@kraftverk/api-contract';
import { capabilityIn, CATEGORIES, describeDeviceType, isBridgedMethod, isSimulated, methodsOf, placementsOf, platformsOf, type Availability, type ConnectionMethod } from '@kraftverk/device-sdk';
import { deviceReader } from '@kraftverk/holder';

import { openBridges } from '../devices/members.ts';
import { runAskedTool } from '../devices/tools.ts';
import { FIRST_PICTURE, PICTURE_REF } from '../devices/views.ts';
import { changesOf } from '../history/changes.ts';
import { MAX_SPAN_MS } from '../history/retention.ts';
import { resolutionOf, series } from '../history/sampler.ts';
import { unfitFor } from '../installed/needs.ts';
import { platformWords } from '../installed/transports.ts';
import type { Hub } from '../node/hub.ts';
import { intentOf } from './caller.ts';
import { checkKey, scopeOf } from './scope.ts';

/*
  The devices you have, how each is reached and how they fit the house, as
  everything that uses a home asks for them (`KraftverkApi`): read, renamed,
  removed; its history; every command and setting through the gateway; its
  type's tools; its connections; the links between parts. Described the same
  whatever they are, so one card, one page and one chart do for all of them.
*/

/**
 * The span a history or changes request asks for: `from` and `to`, or the
 * last `hours` up to now, or the last day. A span that ends before it begins,
 * or reaches further back than anything is kept, is refused.
 */
function spanOf(query: { hours?: number; from?: string; to?: string }): { from: string; to: string } {
  const to = query.to ? new Date(query.to) : new Date();
  const from = query.from ? new Date(query.from) : new Date(to.getTime() - (query.hours ?? 24) * 3_600_000);
  if (query.from && query.hours !== undefined) throw new ApiError('invalid', 'Ask for from and to, or hours: not both');
  if (!(from < to)) throw new ApiError('invalid', 'The span ends before it begins');
  if (to.getTime() - from.getTime() > MAX_SPAN_MS) throw new ApiError('invalid', 'History is kept for two years: ask for less');
  return { from: from.toISOString(), to: to.toISOString() };
}


type DevicesApi = Pick<KraftverkApi, 'deviceTypes' | 'devices' | 'problems' | 'needsYou'>;

export function devicesApi(hub: Hub, caller: Caller): DevicesApi {
  const { catalog, sessions, views, gateway, events } = hub;
  const { types, protocols, transports } = hub.installed;
  const { actor, record, changed, deviceOf, viewOf } = scopeOf(hub, caller);

  /**
   * Whether this home can hold a connection over a method: a simulated one
   * always; otherwise its protocol must be installed, and its transport able
   * to run here.
   */
  const holds = (method: ConnectionMethod): Availability => {
    if (isSimulated(method)) return { ok: true };
    // Through a bridge: while one it goes through is open here — an account added, a gateway reached.
    if (isBridgedMethod(method)) {
      if (openBridges(hub, method.through).length) return { ok: true };
      const which = (method.through ?? []).map((id) => types.get(id)?.meta.name ?? id).join(' or ');
      return { ok: false, reason: `It is reached through ${which}: add that first` };
    }
    // What a way needs of the node holding it — trusted with a vendor account's password — this one may not be.
    const unfit = unfitFor(method, hub.self);
    if (unfit) return { ok: false, reason: unfit };
    const protocol = protocols.get(method.protocol);
    if (!protocol?.bindings[method.transport]) return { ok: false, reason: `${platformWords(transports.platform).this} cannot reach devices this way: it needs updating` };
    return transports.available(method.transport);
  };

  /** Where an installed type came from: every one came from an integration, or it was not installed. */
  const sourceOf = (id: string) => {
    const source = types.sourceOf(id);
    if (!source) throw new Error(`${id} is installed with no integration`);
    return source;
  };

  const toolOf = (id: string, name: string) => {
    const device = deviceOf(id);
    const session = sessions.get(device.id);
    if (!session) throw new ApiError('unavailable', `${device.name} is not answering: ${sessions.health(device).detail}`);
    const spec = sessions.typeOf(device)?.tools?.[name];
    if (!spec || typeof session.tools?.[name] !== 'function') throw new ApiError('not-found', `${device.name} has no tool called "${name}"`);
    return { device, session, spec };
  };

  return {
    /**
     * What can be added: every installed device type, found rather than
     * listed, with the categories they are listed under. A package added
     * appears here with no other change.
     */
    async deviceTypes() {
      const listing: DeviceTypeListing[] = types.all().map((type) => ({
        ...describeDeviceType(type),
        source: sourceOf(type.id),
        placements: placementsOf(type, (id) => transports.definition(id), (id) => types.get(id)),
        /*
          The ways that can be held where this home runs at all — one that
          cannot (the broker in a browser) is not offered, rather than offered
          and refused; one that can, but not now, says why. Every one is the
          home's: this app's own, for a server's home, are its follower's.
        */
        ways: methodsOf(type)
          .filter((method) => platformsOf(method, transports.definition(method.transport)).includes(transports.platform))
          .map((method) => ({ method: method.id, holder: 'master' as const, fits: unfitFor(method, hub.self) === null, availability: holds(method) })),
        warnings: types.warnings(type.id),
      }));
      return {
        categories: CATEGORIES,
        integrations: types.integrations(),
        types: listing,
        transports: transports.definitions(),
        /** Packages that were found and refused, and why: for whoever is writing one. */
        refused: { types: [...types.refused], protocols: [...protocols.refused], transports: [...transports.refused] },
      };
    },

    devices: {
      list: async () => views.all(),
      removed: async () => views.removed(),
      get: async (id) => viewOf(deviceOf(id, { removed: true }).id),

      /**
       * A name, and its key — the name a configuration knows it by — and
       * nothing else. What a device *is* is its type, which does not change;
       * how it is reached is its connections.
       */
      async update(id, changes) {
        const before = deviceOf(id);
        if (changes.key !== undefined && changes.key !== before.key) checkKey(changes.key, catalog.keyTaken(changes.key, before.id), 'device', 'garage-station');
        const updated = catalog.update(before.id, changes);
        if (!updated) throw new ApiError('not-found', 'No such device');
        if (updated.name !== before.name) record('device.renamed', 'device', before.id, `Renamed "${before.name}" to "${updated.name}"`);
        if (updated.key !== before.key) record('device.keyed', 'device', before.id, `"${updated.name}" is now known in configuration as ${updated.key}, not ${before.key}`, { before: before.key, after: updated.key });
        changed();
        return viewOf(before.id);
      },

      /**
       * Which picture a device shows: an owner's choice, kept by the home so
       * every app shows the same. Its type's pictures (`type:N`) are the
       * app's, from its packages. A photo of its own (`own:<id>`) is reserved.
       */
      async setPicture(id, picture) {
        const device = deviceOf(id);
        if (!PICTURE_REF.test(picture)) throw new ApiError('invalid', 'type:0, type:1… (or, one day, own:<id>)');
        if (picture.startsWith('own:')) throw new ApiError('invalid', 'A picture of its own cannot be added yet');
        // Its type's first is what it shows with no pick: kept as none.
        catalog.setPicture(device.id, picture === FIRST_PICTURE ? null : picture);
        record('device.picture', 'device', device.id, `Showed picture ${Number(picture.slice(5)) + 1} of "${device.name}"`, { picture });
        changed();
        return viewOf(device.id);
      },

      /**
       * Pauses a device — kept, with its history, its connections and links,
       * and not reached, by its holder or anything through it — or resumes it.
       */
      async setPaused(id, paused) {
        const device = deviceOf(id);
        if (Boolean(device.pausedAt) !== paused) {
          catalog.setPaused(device.id, paused);
          record(paused ? 'device.paused' : 'device.resumed', 'device', device.id, `${paused ? 'Paused' : 'Resumed'} "${device.name}"`);
          await sessions.sync(catalog.list());
          changed();
        }
        return viewOf(device.id);
      },

      /** Removes a device, keeping its history. Its connections and links go; adding the same device again offers to bring it all back. */
      async remove(id) {
        const device = deviceOf(id);
        catalog.remove(device.id);
        // What a follower last read of it goes with it: brought back, it is read afresh.
        hub.heldReadings.forget(device.id);
        record('device.removed', 'device', device.id, `Removed "${device.name}". Its history is kept.`, { typeId: device.typeId, identity: device.identity });
        // Removing a device closes its session.
        await sessions.sync(catalog.list());
        changed();
      },

      /** Deletes a removed device and everything it recorded. Only a removed one, and only when its name is typed back: nothing else here is irreversible. */
      async deleteHistory(id, name) {
        const device = deviceOf(id, { removed: true });
        if (!device.removedAt) throw new ApiError('conflict', 'Remove the device first');
        if (name.trim() !== device.name) throw new ApiError('invalid', `Type "${device.name}" to confirm`);
        // Written before the delete, so the entry survives whatever happens to it.
        record('device.history-deleted', 'device', device.id, `Deleted "${device.name}" and everything it had recorded`, {
          typeId: device.typeId,
          identity: device.identity,
          addedAt: device.addedAt,
          removedAt: device.removedAt,
        });
        return { samples: catalog.deleteForever(device.id).samples };
      },

      /** One measurement over time, thinned: a fortnight of minute samples is far more than a phone-sized chart can show. A removed device's is still there. */
      async history(id, query: HistoryQuery) {
        const device = deviceOf(id, { removed: true });
        const { from, to } = spanOf(query);
        return { deviceId: device.id, key: query.key, from, to, resolution: resolutionOf(from, to), points: series(hub.history, device.id, query.key, from, to, query.points ?? 240) };
      },

      /** Every change of an on/off or an enum in a span, exactly when it happened: what a timeline draws. */
      async changes(id, query: ChangesQuery) {
        const device = deviceOf(id, { removed: true });
        const { from, to } = spanOf(query);
        return { deviceId: device.id, from, to, changes: changesOf(hub.history, device.id, sessions.description(device), { from, to, key: query.key }) };
      },

      /** What a device said happened, newest first. A removed device's are still there to look at. */
      events: async (id, limit = 100) => events.recent(deviceOf(id, { removed: true }).id, limit),

      /**
       * A command to one part of a device, through the gateway, which checks
       * the part offers the capability and the arguments are the command's
       * own. A refusal is an answer: the gateway's verdict, which carries a
       * token when a person only has to say yes.
       */
      async command(id, part, capability, command, body) {
        const device = deviceOf(id);
        // The library's, or one the device's own description declares.
        if (!capabilityIn(sessions.description(device), capability)) throw new ApiError('not-found', `"${capability}" is not a capability of ${device.name}`);
        return gateway.execute({
          deviceId: device.id,
          part,
          capability,
          command,
          args: body.args,
          reason: body.reason ?? 'From the device screen',
          ...intentOf(caller),
          confirmation: body.confirmation,
        });
      },

      /**
       * Writes what a device remembers — its settings — through the gateway,
       * like a command: held to their types, refused while read-only,
       * confirmed for one that can damage the hardware, verified by reading
       * back, and audited.
       */
      write: async (id, write) => gateway.write({ deviceId: deviceOf(id).id, patch: write.patch, ...intentOf(caller), confirmation: write.confirmation }),

      /** A query its capability declares — a forecast's hours — asked of the device now, and answered in the type declared. */
      async query(id, part, capability, query, args) {
        const device = deviceOf(id);
        const session = sessions.get(device.id);
        if (!session) throw new ApiError('unavailable', `${device.name} is not answering: ${sessions.health(device).detail}`);
        return deviceReader(session, () => sessions.description(device)).query({ part, capability, query, args });
      },

      /**
       * A device type's own tools, declared as data: a register dump, a raw
       * frame. The holder checks each one's input against what it asks for and
       * its answer against what it declares. One that writes is refused while
       * read-only, and audited — refused too, since an attempt at the brick
       * write is what the timeline is for; one that says what it cannot undo
       * waits for a person's yes, bound to this device, tool, input and person.
       */
      async tool(id, name, body) {
        const { device, session, spec } = toolOf(id, name);
        return runAskedTool({
          device,
          name,
          spec,
          session,
          body,
          by: actor,
          confirmations: hub.yes.tools,
          readOnly: hub.readOnly() && !sessions.simulated(device.id),
          record: (kind, summary, detail) => record(kind, 'device', device.id, summary, detail),
        });
      },
    },

    /** Warnings and errors across the devices you have, newest first: what wants looking at. */
    problems: async (limit = 100) => events.problems(limit),

    /**
     * What waits on a person: each device or account that needs signing in to
     * again — its own need, not one it only takes from the bridge it is
     * behind, which is listed once, as the bridge — and each device found
     * and not added yet, on the home's network or behind a bridge of yours,
     * unless you said it is not yours.
     */
    async needsYou() {
      const all = views.all();
      const needing = new Set(all.filter((device) => device.health.status === 'needs-you').map((device) => device.id));
      const acts = all
        .filter((device) => needing.has(device.id) && !device.connections.some((connection) => connection.through !== null && needing.has(connection.through.id)))
        .map((device) => ({ kind: 'act' as const, device: { id: device.id, name: device.name, kind: device.kind, integration: device.integration }, detail: device.health.detail }));
      const found = hub.nearby.list().filter((entry) => !entry.ignored);
      return [...acts, ...found.map((entry) => ({ kind: 'found' as const, found: entry }))];
    },

  };
}
