import { ApiError, type Caller, type ChangesQuery, type DeviceTypeListing, type HistoryQuery, type KraftverkApi } from '@kraftverk/api-contract';
import {
  CATEGORIES,
  capabilityIn,
  describeDeviceType,
  isLinkKind,
  isSecretField,
  isSimulated,
  KEY,
  linkFits,
  linkKindSpec,
  methodsOf,
  partName,
  partsOf,
  placesOf,
  savedDeviceId,
  type Availability,
  type ConnectionMethod,
  type ResourceKind,
  type SavedDeviceId,
} from '@kraftverk/device-sdk';
import { subjectOf } from '@kraftverk/gateway';
import { deviceReader, runTool, ToolRefused, type ToolRefusal } from '@kraftverk/holder';
import type { DeviceRecord } from '@kraftverk/store';

import { PICTURE_REF } from '../devices/registry.ts';
import { changesOf } from '../history/changes.ts';
import { resolutionOf, series } from '../history/sampler.ts';
import type { Hub } from '../hub.ts';
import { unfitFor } from '../installed/needs.ts';
import { platformWords } from '../installed/transports.ts';
import { connectionSchema } from '../setup/index.ts';
import { actorOf, intentOf } from './caller.ts';

/*
  The devices you have, how each is reached and how they fit the house, as
  everything that uses a home asks for them (`KraftverkApi`): read, renamed,
  removed; its history; every command and setting through the gateway; its
  type's tools; its connections; the links between parts. Described the same
  whatever they are, so one card, one page and one chart do for all of them.
*/

/** The longest span history or changes are asked for: as long as they are kept. */
const MAX_SPAN_MS = 730 * 86_400_000;

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

/** Why a tool was refused, as the kind of refusal it is. */
const TOOL_REFUSAL: Record<ToolRefusal, ApiError['kind']> = { missing: 'not-found', input: 'invalid', 'read-only': 'locked', failed: 'conflict', answer: 'failed' };

type DevicesApi = Pick<KraftverkApi, 'deviceTypes' | 'devices' | 'problems' | 'connections' | 'links'>;

export function devicesApi(hub: Hub, caller: Caller): DevicesApi {
  const { catalog, connections, links, sessions, registry, gateway, events } = hub;
  const { types, protocols, transports } = hub.installed;
  const actor = actorOf(caller);

  /** What happened, on the timeline, as this caller did it. */
  const record = (kind: string, resourceKind: ResourceKind, resource: string, summary: string, detail?: unknown) =>
    hub.audit.record({ at: new Date().toISOString(), kind, actor, resourceKind, resource, summary, detail });
  /** What a list of devices shows changed: every open screen reads it again. */
  const changed = () => hub.bus.publish({ kind: 'changed', deviceId: null });

  /**
   * The device asked for, or no such device. There is no inference, not even
   * "when there is only one": a guess right while you own one device is wrong,
   * silently, the day you own two.
   */
  const deviceOf = (id: string, { removed = false } = {}): DeviceRecord => {
    const found = removed ? catalog.get(savedDeviceId(id)) : catalog.active(savedDeviceId(id));
    if (!found) throw new ApiError('not-found', 'No such device');
    return found;
  };
  const viewOf = (id: SavedDeviceId) => {
    const view = registry.find(id);
    if (!view) throw new ApiError('not-found', 'No such device');
    return view;
  };
  const connectionOf = (deviceId: string, connectionId: string) => {
    const device = deviceOf(deviceId);
    const connection = connections.get(connectionId);
    if (!connection || connection.deviceId !== device.id) throw new ApiError('not-found', 'No such connection');
    return { device, connection };
  };

  /**
   * Whether this home can hold a connection over a method: a simulated one
   * always; otherwise its protocol must be installed, and its transport able
   * to run here.
   */
  const holds = (method: ConnectionMethod): Availability => {
    if (isSimulated(method)) return { ok: true };
    // What a way needs of the node holding it — trusted with a vendor account's password — this one may not be.
    const unfit = unfitFor(method, hub.self);
    if (unfit) return { ok: false, reason: unfit };
    const protocol = protocols.get(method.protocol);
    if (!protocol?.bindings[method.transport]) return { ok: false, reason: `${platformWords(transports.platform).this} cannot reach devices this way: it needs updating` };
    return transports.available(method.transport);
  };

  /** "Garage station — Mains", or a device's name for its main part: how a link's ends read on the timeline. */
  const endName = (end: { device: string; part: string }): string => {
    const device = catalog.get(savedDeviceId(end.device));
    if (!device) return 'a removed device';
    const part = partsOf(device.removedAt ? device.description : sessions.description(device)).find((candidate) => candidate.id === end.part);
    return partName(device.name, end.part, part?.label ?? end.part);
  };

  const toolOf = (id: string, name: string) => {
    const device = deviceOf(id);
    const session = sessions.get(device.id);
    if (!session) throw new ApiError('conflict', sessions.health(device).detail);
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
        /*
          The ways that can be held where this home runs at all — one that
          cannot (the broker in a browser) is not offered, rather than offered
          and refused; one that can, but not now, says why. Every one is the
          home's: this app's own, for a server's home, are its holding's.
        */
        ways: methodsOf(type)
          .filter((method) => placesOf(method, transports.definition(method.transport)).includes(transports.platform))
          .map((method) => ({ method: method.id, holder: 'master' as const, fits: unfitFor(method, hub.self) === null, availability: holds(method) })),
        warnings: types.warnings(type.id),
      }));
      return {
        categories: CATEGORIES,
        types: listing,
        transports: transports.definitions(),
        /** Packages that were found and refused, and why: for whoever is writing one. */
        refused: { types: [...types.refused], protocols: [...protocols.refused], transports: [...transports.refused] },
      };
    },

    devices: {
      list: async () => registry.all(),
      removed: async () => registry.removed(),
      get: async (id) => viewOf(deviceOf(id, { removed: true }).id),

      /**
       * A name, and its key — the name a configuration knows it by — and
       * nothing else. What a device *is* is its type, which does not change;
       * how it is reached is its connections.
       */
      async update(id, changes) {
        const before = deviceOf(id);
        if (changes.key !== undefined && changes.key !== before.key) {
          if (!KEY.test(changes.key)) throw new ApiError('invalid', 'A key is lowercase letters, digits and dashes: "garage-station"');
          if (catalog.keyTaken(changes.key, before.id)) throw new ApiError('conflict', `Another device is known by "${changes.key}"`);
        }
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
        catalog.setPicture(device.id, picture === 'type:0' ? null : picture);
        record('device.picture', 'device', device.id, `Showed picture ${Number(picture.slice(5)) + 1} of "${device.name}"`, { picture });
        changed();
        return viewOf(device.id);
      },

      /** Removes a device, keeping its history. Its connections and links go; adding the same device again offers to bring it all back. */
      async remove(id) {
        const device = deviceOf(id);
        catalog.remove(device.id);
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
        return { deviceId: device.id, key: query.key, from, to, resolution: resolutionOf(from, to), points: series(hub.db, device.id, query.key, from, to, query.points ?? 240) };
      },

      /** Every change of an on/off or an enum in a span, exactly when it happened: what a timeline draws. */
      async changes(id, query: ChangesQuery) {
        const device = deviceOf(id, { removed: true });
        const { from, to } = spanOf(query);
        return { deviceId: device.id, from, to, changes: changesOf(hub.db, device.id, sessions.description(device), { from, to, key: query.key }) };
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
        if (body.reading && spec.writes) throw new ApiError('not-allowed', `${name} changes the device: send it as a write`);
        const input = body.input ?? {};
        if (spec.writes && spec.confirm) {
          const subject = subjectOf({ device: device.id, tool: name, input, by: actor });
          if (!hub.yes.tools.accept(body.confirmation, subject)) throw new ApiError('needs-yes', spec.confirm, { needsConfirmation: hub.yes.tools.ask(subject) });
        }
        try {
          const answer = await runTool({ deviceName: device.name, name, spec, session, input, readOnly: hub.readOnly() && !sessions.simulated(device.id) });
          if (spec.writes) record('device.tool', 'device', device.id, `Ran ${spec.label.toLowerCase()} on "${device.name}"`, { tool: name, input });
          return answer;
        } catch (error) {
          if (spec.writes) record('device.tool-refused', 'device', device.id, `${spec.label} on "${device.name}" was refused: ${(error as Error).message}`, { tool: name, input });
          if (error instanceof ToolRefused) throw new ApiError(TOOL_REFUSAL[error.reason], error.message);
          throw error;
        }
      },
    },

    /** Warnings and errors across the devices you have, newest first: what wants looking at. */
    problems: async (limit = 100) => events.problems(limit),

    connections: {
      /** Makes this the way to reach the device, whenever it can be reached. */
      async prefer(deviceId, connectionId) {
        const { device, connection } = connectionOf(deviceId, connectionId);
        connections.prefer(connection.id);
        record('device.connection-preferred', 'device', device.id, `"${device.name}" is now reached by ${connection.method} first`);
        await sessions.sync(catalog.list());
        changed();
        return viewOf(device.id);
      },

      /** Removes one way to reach a device. Not the last: that is removing the device. */
      async remove(deviceId, connectionId) {
        const { device, connection } = connectionOf(deviceId, connectionId);
        if (connections.forDevice(device.id).length <= 1) throw new ApiError('conflict', 'This is the only way to reach it. Remove the device instead.');
        connections.remove(connection.id);
        record('device.connection-removed', 'device', device.id, `"${device.name}" is no longer reached by ${connection.method} (${connection.address})`);
        await sessions.sync(catalog.list());
        changed();
        return viewOf(device.id);
      },

      /** Replaces a connection's secrets, held by this home: a plug's local key can change every time it is paired again. Write-only, like every secret. */
      async setSecrets(deviceId, connectionId, given) {
        const { device, connection } = connectionOf(deviceId, connectionId);
        if (connection.heldBy !== hub.self.id) throw new ApiError('conflict', 'That connection’s secrets are kept by the node that holds it');
        const method = sessions.typeOf(device)?.connections.find((candidate) => candidate.id === connection.method) ?? null;
        const schema = connectionSchema(method, method ? protocols.get(method.protocol) : null);
        const refused = Object.keys(given).filter((field) => !schema.fields[field] || !isSecretField(schema.fields[field]!));
        if (refused.length) throw new ApiError('invalid', `Not a secret of this connection: ${refused.join(', ')}`);
        connections.setSecrets(connection.id, given);
        // Which fields, never their values.
        record('device.secrets-changed', 'device', device.id, `Changed ${Object.keys(given).join(', ')} for "${device.name}"`);
        // Reopened, so the new key is used now rather than at the next restart.
        await sessions.close(device.id);
        await sessions.sync(catalog.list());
        changed();
        return viewOf(device.id);
      },

      /** Whether a connection's secrets may leave in an export as plain text: its owner's choice, off unless chosen. */
      async setExportable(deviceId, connectionId, exportable) {
        const { device, connection } = connectionOf(deviceId, connectionId);
        if (connection.heldBy !== hub.self.id) throw new ApiError('conflict', 'That connection’s secrets are kept by the node that holds it, and never exported');
        if (exportable !== connection.secretsExportable) {
          connections.update(connection.id, { secretsExportable: exportable });
          record(
            'device.exportable',
            'device',
            device.id,
            exportable ? `"${device.name}": its ${connection.method} secrets may now leave in an export as plain text` : `"${device.name}": its ${connection.method} secrets no longer leave in plain text`,
            { connection: connection.id, secretsExportable: exportable }
          );
          changed();
        }
        return viewOf(device.id);
      },
    },

    links: {
      /** Records a fact about the house, between two parts: this plug's relay feeds that station's mains input. */
      async add(input) {
        if (!isLinkKind(input.kind)) throw new ApiError('invalid', `There is no link called "${input.kind}"`);
        const source = deviceOf(input.source.device);
        const target = deviceOf(input.target.device);
        if (source.id === target.id) throw new ApiError('invalid', 'A device cannot be linked to itself');
        const kind = linkKindSpec(input.kind);
        if (!linkFits(input.kind, sessions.description(source), input.source.part, sessions.description(target), input.target.part)) {
          throw new ApiError('invalid', `"${endName(input.source)}" cannot be said to ${kind.verb.replace(/s$/, '')} "${endName(input.target)}": the one must offer ${kind.from}, the other ${kind.to}`);
        }
        const link = links.add({ kind: input.kind, source: { device: source.id, part: input.source.part }, target: { device: target.id, part: input.target.part } });
        record('device.linked', 'device', source.id, `"${endName(link.source)}" ${kind.verb} "${endName(link.target)}"`, { kind: link.kind, source: link.source, target: link.target });
        changed();
        return link;
      },

      async remove(id) {
        const link = links.get(id);
        if (!link) throw new ApiError('not-found', 'No such link');
        links.remove(link.id);
        record('device.unlinked', 'device', link.source.device, `"${endName(link.source)}" no longer ${linkKindSpec(link.kind).verb} "${endName(link.target)}"`);
        changed();
      },
    },
  };
}
