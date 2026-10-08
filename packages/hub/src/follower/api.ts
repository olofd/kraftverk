import { ApiError, type AutomationView, type DeviceView, type DraftView, type KraftverkApi, type LiveUpdate, type TransportView, type WayView } from '@kraftverk/api-contract';
import { capabilityIn, connectionId as asConnectionId, methodOf, transportOf, type SavedDeviceId } from '@kraftverk/device-sdk';
import { deviceReader } from '@kraftverk/holder';

import { joinBridge, runAskedTool } from '../devices/tools.ts';
import { coalesced } from '../live/stream.ts';
import { checkSecretFields } from '../installed/connection-schema.ts';
import { holdableHere } from '../installed/holdable.ts';
import type { Follower } from './follower.ts';
import { HEARD } from './heard.ts';

/*
  The master's `KraftverkApi`, with what this node holds wrapped in
  (docs/PLAN-SHARED-CORE.md, phase 6): the one interface the screens ask,
  as they would ask any home. What the screens read is kept as the master
  answers it, and while the master cannot be reached, answered from what it
  last said — devices it holds offline, saying so; anything that would
  change something is refused by the master's absence. A device's view
  carries this node's own readings while it holds the device; a command, a setting, a query or a
  tool to one goes through this node's own gateway and session; a way this
  node holds is set up here, its secrets kept here; the live stream carries
  what this node hears beside what the master says. The rest is the
  master's, asked as it is.
*/


export function followerApi(h: Follower): KraftverkApi {
  const { home } = h;
  /** The master's list — or, with it away, what it last said — held from, and with this node's own wrapped in. */
  const listed = async (what: typeof HEARD.devices | typeof HEARD.removed, ask: () => Promise<DeviceView[]>): Promise<DeviceView[]> => {
    const { answer, heardAt } = await h.kept(what, ask);
    if (what === HEARD.devices && !heardAt) await h.hold(answer);
    return answer.map((view) => h.view(heardAt ? h.lastHeard(view) : view));
  };
  /** One device as the master says it — or, with it away, as it last said it — with this node's own wrapped in. */
  const viewed = async (view: Promise<DeviceView>): Promise<DeviceView> => h.view(await view);
  const oneOf = async (id: SavedDeviceId): Promise<DeviceView> => {
    try {
      return h.view(await home.devices.get(id));
    } catch (error) {
      if (!(error instanceof ApiError && error.kind === 'unavailable')) throw error;
      const last = [...(h.heard.get<DeviceView[]>(HEARD.devices)?.body ?? []), ...(h.heard.get<DeviceView[]>(HEARD.removed)?.body ?? [])].find((device) => device.id === id);
      if (!last) throw error;
      return h.view(h.lastHeard(last));
    }
  };
  /** After the master changed a device's ways: what this node holds, again. */
  const again = async (view: DeviceView): Promise<DeviceView> => {
    await h.refresh();
    return h.view(view);
  };
  /** A device this node holds now: its record and session, or why it cannot be asked. */
  const heldDevice = (id: SavedDeviceId) => {
    const device = h.catalog.active(id)!;
    const session = h.sessions.get(id);
    if (!session) throw new ApiError('unavailable', `${device.name} is not answering: ${h.sessions.health(device).detail}`);
    return { device, session };
  };
  const intent = () => ({ by: { kind: 'person' as const, id: null, name: h.name } });
  /** A home changed on the master: the list kept here asked again, so what this node shows is as the master has it. */
  const keepingHomes = async <T>(answer: T): Promise<T> => {
    await h.kept(HEARD.homes(false), () => home.homes.list()).catch(() => undefined);
    return answer;
  };

  // --- setting up a way this node holds ---------------------------------------------
  /** Drafts set up here, and the master's draft each became once read. */
  const drafts = new Map<string, string | null>();
  const local = (id: string) => drafts.has(id);
  const ownDraft = (view: DraftView): DraftView => ({ ...view, heldBy: h.nodeId });

  return {
    /** The master's types, with the ways this node can hold for it: a type this node has installed too, over a way it can hold where it runs. */
    async deviceTypes() {
      const { answer: list } = await h.kept(HEARD.deviceTypes, () => home.deviceTypes());
      // Read, not started: the transports this node uses started with it (`Follower.start`).
      const { transports } = h.installed;
      return {
        ...list,
        types: list.types.map((listing) => {
          const type = h.installed.types.get(listing.id);
          const mine: WayView[] = type
            ? type.connections.filter((method) => holdableHere(h.installed, h.self, method)).map((method) => ({ method: method.id, holder: 'this-node', fits: true, availability: transports.available(transportOf(method)) }))
            : [];
          return { ...listing, ways: [...listing.ways, ...mine] };
        }),
      };
    },

    devices: {
      list: () => listed(HEARD.devices, () => home.devices.list()),
      removed: () => listed(HEARD.removed, () => home.devices.removed()),
      get: oneOf,
      update: (id, changes) => viewed(home.devices.update(id, changes)),
      setPicture: (id, picture) => viewed(home.devices.setPicture(id, picture)),
      setPaused: (id, paused) => viewed(home.devices.setPaused(id, paused)),
      setTrack: (id, days) => viewed(home.devices.setTrack(id, days)),
      place: (id, placement) => viewed(home.devices.place(id, placement)),
      placements: (id) => home.devices.placements(id),
      track: (id, since) => home.devices.track(id, since),
      async remove(id) {
        await home.devices.remove(id);
        await h.forget(id);
      },
      deleteHistory: (id, name) => home.devices.deleteHistory(id, name),
      history: (id, query) => home.devices.history(id, query),
      changes: (id, query) => home.devices.changes(id, query),
      events: (id, limit) => home.devices.events(id, limit),

      /** To a device this node holds: through this node's gateway, as the home's would — checked, confirmed, verified, on the timeline. */
      async command(id, part, capability, command, body) {
        if (!h.holds(id)) return home.devices.command(id, part, capability, command, body);
        const { device } = heldDevice(id);
        if (!capabilityIn(h.sessions.description(device), capability)) throw new ApiError('not-found', `"${capability}" is not a capability of ${device.name}`);
        return h.gateway.execute({ deviceId: device.id, part, capability, command, args: body.args, reason: body.reason ?? 'From this app', ...intent(), confirmation: body.confirmation });
      },
      write: (id, write) => (h.holds(id) ? h.gateway.write({ deviceId: id, patch: write.patch, ...intent(), confirmation: write.confirmation }) : home.devices.write(id, write)),
      async query(id, part, capability, query, args) {
        if (!h.holds(id)) return home.devices.query(id, part, capability, query, args);
        const { device, session } = heldDevice(id);
        return deviceReader(session, () => h.sessions.description(device)).query({ part, capability, query, args });
      },
      /** A tool this node's session runs, held to its declaration both ways; one that cannot be undone waits for a person's yes. */
      async tool(id, name, body) {
        if (!h.holds(id)) return home.devices.tool(id, name, body);
        const { device, session } = heldDevice(id);
        const spec = h.installed.types.get(device.typeId)?.tools?.[name];
        if (!spec || typeof session.tools?.[name] !== 'function') throw new ApiError('not-found', `${device.name} has no tool called "${name}"`);
        return runAskedTool({
          device,
          name,
          spec,
          session,
          body,
          by: intent().by,
          confirmations: h.yes,
          readOnly: h.readOnly() && !h.sessions.simulated(device.id),
          record: (kind, summary, detail) => h.owe('audit', null, { at: new Date().toISOString(), kind, actor: intent().by, resourceKind: 'device', resource: device.id, summary, detail }),
        });
      },
      /** A bridge this node holds lets devices join here; any other, where it is held. */
      async join(id, seconds) {
        if (!h.holds(id)) return home.devices.join(id, seconds);
        const { device, session } = heldDevice(id);
        return joinBridge({
          device,
          joining: session.bridge?.join ?? null,
          seconds,
          readOnly: h.readOnly() && !h.sessions.simulated(device.id),
          record: (kind, summary, detail) => h.owe('audit', null, { at: new Date().toISOString(), kind, actor: intent().by, resourceKind: 'device', resource: device.id, summary, detail }),
        });
      },
    },

    problems: async (limit) => (await h.kept(HEARD.problems(limit), () => home.problems(limit))).answer,
    needsYou: async () => (await h.kept(HEARD.needsYou, () => home.needsYou())).answer,

    setup: {
      /** A way this node holds is set up here, over its own radio; any other, by the master. */
      async start({ holder, ...input }) {
        if (holder !== 'this-node') return home.setup.start(input);
        const type = h.installed.types.get(input.typeId);
        const method = type && input.methodId ? methodOf(type, input.methodId) : null;
        if (!type || !method || !holdableHere(h.installed, h.self, method)) throw new ApiError('conflict', 'This app cannot hold that way itself: it needs updating, or it is your server’s');
        const draft = await h.setup.start({ typeId: input.typeId, methodId: method.id, by: intent().by });
        drafts.set(draft.id, null);
        return ownDraft(draft);
      },
      startHeld: (input) => home.setup.startHeld(input),
      // A way is set up again by the home that keeps it.
      again: (input) => home.setup.again(input),
      get: async (id) => (local(id) ? ownDraft(h.setup.view(id)) : home.setup.get(id)),
      async discard(id) {
        if (!local(id)) return home.setup.discard(id);
        h.setup.discard(id);
        const judged = drafts.get(id);
        drafts.delete(id);
        if (judged) await home.setup.discard(judged).catch(() => undefined);
      },
      sightings: async (id) => (local(id) ? h.setup.sightings(id) : home.setup.sightings(id)),
      choose: async (id, choice) => (local(id) ? ownDraft(await h.setup.choose(id, choice)) : home.setup.choose(id, choice)),
      update: async (id, values) => (local(id) ? ownDraft(h.setup.update(id, values)) : home.setup.update(id, values)),
      action: (id, step, action, input, signal) => (local(id) ? h.setup.action(id, step, action, input, signal) : home.setup.action(id, step, action, input, signal)),
      discover: (id, step, signal) => (local(id) ? h.setup.discover(id, step, signal) : home.setup.discover(id, step, signal)),

      /**
       * Read here, over this node's own radio, and judged by the master
       * against what you have — new, yours, yours before, another model —
       * from what was read, never a secret.
       */
      async check(id) {
        if (!local(id)) return home.setup.check(id);
        const { draft, read } = await h.setup.read(id);
        const me = await h.joined();
        const judged = await home.setup.startHeld({
          nodeId: me,
          typeId: draft.typeId,
          methodId: draft.methodId!,
          address: draft.address!,
          // A member of a bridge this node holds: its way goes through that bridge.
          ...(draft.through ? { through: draft.through } : {}),
          identified:
            'identified' in read
              ? { identity: read.identified.identity, model: read.identified.model, name: read.identified.name, summary: read.identified.summary, config: read.identified.config }
              : null,
          ...('outcome' in read ? { failure: read.outcome.summary } : {}),
          device: draft.device as never,
          connection: draft.connection as never,
        });
        const before = drafts.get(id);
        if (before) await home.setup.discard(before).catch(() => undefined);
        drafts.set(id, judged.id);
        return judged.checked!;
      },

      /** Saved by the master — the device, this node's way, its links — and the way's secrets kept here, never sent. */
      async save(id, input) {
        if (!local(id)) return home.setup.save(id, input);
        const judged = drafts.get(id);
        if (!judged) throw new ApiError('conflict', 'Check that it answers first');
        // The secrets as they were given, not as a device that must answer again would say them: one that does not answer now kept none.
        const draft = h.setup.view(id);
        const secrets = h.setup.secrets(id);
        const saved = await home.setup.save(judged, input);
        const me = h.nodeId;
        const way = saved.connections.find((connection) => connection.heldBy.id === me && connection.method === draft.methodId);
        await h.hold(await home.devices.list());
        if (way && Object.keys(secrets).length) await h.setSecrets(way.id, secrets);
        h.setup.discard(id);
        drafts.delete(id);
        return h.view(await home.devices.get(saved.id));
      },
    },

    nearby: () => home.nearby(),
    // What an integration keeps is kept where its setups are held: the master's. Each call its own, as every
    // other here: the master's API may be a proxy across a port, whose namespaces are not objects of their own.
    integrations: {
      kept: (integration) => home.integrations.kept(integration),
      forget: (integration, key) => home.integrations.forget(integration, key),
    },
    ignoreFound: (at) => home.ignoreFound(at),
    unignoreFound: (at) => home.unignoreFound(at),

    transports: {
      /** The master's, and this node's own: what it holds the master's ways over, here. */
      async list() {
        const { answer: list } = await h.kept(HEARD.transports, () => home.transports.list());
        const { transports } = h.installed;
        const mine = h.installed.transports.here().map((id): TransportView => {
          const transport = transports.get(id);
          return {
            ...transports.definition(id)!,
            holder: 'this-node',
            running: transport !== null,
            availability: transports.available(id),
            values: transport?.values?.() ?? {},
            diagnostics: [],
          };
        });
        return { ...list, transports: [...list.transports, ...mine] };
      },
      diagnostic: (transport, name, query) => home.transports.diagnostic(transport, name, query),
    },

    connections: {
      prefer: async (device, connection) => again(await home.connections.prefer(device, connection)),
      async remove(device, connection) {
        const view = await home.connections.remove(device, connection);
        return again(view);
      },
      /** A way this node holds keeps its secrets here, and they are never sent; any other way's are the master's. */
      async setSecrets(device, connection, secrets) {
        if (!h.owns(connection)) return home.connections.setSecrets(device, connection, secrets);
        const record = h.catalog.active(device);
        const way = h.connections.get(asConnectionId(connection));
        const type = record ? h.installed.types.get(record.typeId) : null;
        const method = type && way ? methodOf(type, way.method) : null;
        checkSecretFields(method, method ? (h.installed.protocols.get(method.protocol) ?? null) : null, secrets);
        await h.setSecrets(connection, secrets);
        h.owe('audit', null, { at: new Date().toISOString(), kind: 'device.secrets-changed', actor: intent().by, resourceKind: 'device', resource: device, summary: `Changed ${Object.keys(secrets).join(', ')} for "${record?.name ?? device}", kept by ${h.name}` });
        return h.view(await home.devices.get(device));
      },
      setExportable: (device, connection, exportable) => home.connections.setExportable(device, connection, exportable),
    },

    links: {
      add: (link) => home.links.add(link),
      remove: (id) => home.links.remove(id),
    },

    automations: {
      kit: () => home.automations.kit(),
      draft: (draft, self) => home.automations.draft(draft, self),
      list: async (filter) => (await h.kept(HEARD.automations(filter?.device), () => home.automations.list(filter))).answer,
      async get(id) {
        try {
          return await home.automations.get(id);
        } catch (error) {
          const last = error instanceof ApiError && error.kind === 'unavailable' ? h.heard.get<AutomationView[]>(HEARD.automations())?.body.find((automation) => automation.id === id) : null;
          if (!last) throw error;
          return last;
        }
      },
      create: (automation) => home.automations.create(automation),
      update: (id, changes) => home.automations.update(id, changes),
      delete: (id) => home.automations.delete(id),
      start: (id) => home.automations.start(id),
      stop: (id) => home.automations.stop(id),
      check: (id) => home.automations.check(id),
      runs: (id, limit) => home.automations.runs(id, limit),
      runLog: (id, runId) => home.automations.runLog(id, runId),
      rehearse: (subject, hours) => home.automations.rehearse(subject, hours),
      fromRecipe: (recipe, params) => home.automations.fromRecipe(recipe, params),
    },

    configuration: {
      vocabulary: () => home.configuration.vocabulary(),
      schema: () => home.configuration.schema(),
      export: (request, options) => home.configuration.export(request, options),
      /** A file, planned by the master; or the home this node kept itself, moving to it. */
      async plan(request) {
        if (!('from' in request)) return home.configuration.plan(request);
        if (request.from !== 'this-node' || !h.moving) throw new ApiError('not-found', request.from === 'copy' ? 'A server’s home is not kept from a copy of itself' : 'This app keeps no home of its own to move');
        return h.moving.plan(request.mode ?? 'merge');
      },
      apply: (answers) => (h.moving?.owns(answers.plan) ? h.moving.apply(answers) : home.configuration.apply(answers)),
      elsewhere: async () => h.moving?.what() ?? null,
    },

    policy: {
      list: async () => {
        const { answer } = await h.kept(HEARD.policy, () => home.policy.list());
        return answer;
      },
      /** Set on the master, and kept here: this node's gateway weighs what it holds by the same values. */
      set: async (name, value) => {
        const values = await home.policy.set(name, value);
        // What the master answers is how they are now: what this node weighs by, and shows while it is away.
        h.heard.keep(HEARD.policy, values);
        return values;
      },
    },

    family: async () => (await h.kept(HEARD.family, () => home.family())).answer,
    /** A home's spaces and openings are the master's: asked of it, as it says them. */
    spaces: {
      list: (homeId, options) => home.spaces.list(homeId, options),
      add: (input) => home.spaces.add(input),
      update: (id, changes) => home.spaces.update(id, changes),
      remove: (id) => home.spaces.remove(id),
    },
    openings: {
      list: (homeId) => home.openings.list(homeId),
      add: (input) => home.openings.add(input),
      update: (id, changes) => home.openings.update(id, changes),
      remove: (id) => home.openings.remove(id),
    },
    /** Pictures are the master's: kept there, and fetched from there. */
    media: {
      add: (picture) => home.media.add(picture),
      get: (id) => home.media.get(id),
    },
    /** The family's homes, as the master last said them; changed on the master, and its list kept here again. */
    homes: {
      list: async (options = {}) => (await h.kept(HEARD.homes(Boolean(options.removed)), () => home.homes.list(options))).answer,
      add: async (input) => keepingHomes(await home.homes.add(input)),
      update: async (id, changes) => keepingHomes(await home.homes.update(id, changes)),
      remove: async (id) => keepingHomes(await home.homes.remove(id)),
    },
    timeline: (query) => home.timeline(query),
    world: () => home.world(),
    vocabulary: () => home.vocabulary(),

    nodes: {
      join: (node) => home.nodes.join(node),
      // With the master away, as this node kept them: who the master is, and who follows it.
      list: async () => (await h.kept(HEARD.nodes, () => home.nodes.list())).answer,
      forget: (id) => home.nodes.forget(id),
    },
    held: {
      readings: (device, upload) => home.held.readings(device, upload),
      store: (device) => home.held.store(device),
      keep: (device, key, entry) => home.held.keep(device, key, entry),
      audit: (node, entries) => home.held.audit(node, entries),
    },

    /**
     * The master's stream, and what this node hears from what it holds: a
     * device this node holds is said by this node — its readings and health
     * first-hand — and the master's word on it, which comes later and second
     * hand, is left out. A change to what this node holds reads the list
     * again, which holds from it again.
     */
    live(listener, options = {}) {
      const stop = coalesced(h.bus, listener, options.draining);
      const stream = home.live((update: LiveUpdate) => {
        if ((update.type === 'readings' || update.type === 'health') && h.holds(update.deviceId)) return;
        listener(update);
      }, options);
      return {
        say: (view) => stream.say(view),
        close: () => {
          stream.close();
          stop();
        },
      };
    },
  };
}
