import { ApiError, type AutomationView, type DeviceView, type DraftView, type KraftverkApi, type LiveUpdate, type TransportView, type WayView } from '@kraftverk/api-contract';
import { capabilityIn, connectionId as asConnectionId, isSecretField, methodOf, type SavedDeviceId } from '@kraftverk/device-sdk';
import { subjectOf } from '@kraftverk/gateway';
import { deviceReader, runTool, ToolRefused, type ToolRefusal } from '@kraftverk/holder';

import { Outbox } from '../live/outbox.ts';
import { connectionSchema } from '../setup/index.ts';
import { holdableHere } from './holdable.ts';
import type { Follower } from './follower.ts';

/*
  The server's `KraftverkApi`, with what this app holds wrapped in
  (docs/PLAN-SHARED-CORE.md, phase 6): the one interface the screens ask,
  as they would ask any home. What the screens read is kept as the server
  answers it, and while the server cannot be reached, answered from what it
  last said — devices it holds offline, saying so; anything that would
  change something is refused by the server's absence. A device's view
  carries this app's own readings while it holds the device; a command, a setting, a query or a
  tool to one goes through this app's own gateway and session; a way this
  app holds is set up here, its secrets kept here; the live stream carries
  what this app hears beside what the server says. The rest is the
  server's, asked as it is.
*/

/** What the live stream from what this app holds coalesces over, as a home's does. */
const FLUSH_MS = 250;
/** Why a tool was refused, as the kind of refusal it is: the home's map. */
const TOOL_REFUSAL: Record<ToolRefusal, ApiError['kind']> = { missing: 'not-found', input: 'invalid', 'read-only': 'locked', failed: 'conflict', answer: 'failed' };

export function followerApi(h: Follower): KraftverkApi {
  const { home } = h;
  /** The server's list — or, with it away, what it last said — held from, and with this app's own wrapped in. */
  const listed = async (what: 'devices' | 'removed', ask: () => Promise<DeviceView[]>): Promise<DeviceView[]> => {
    const { answer, heardAt } = await h.kept(what, ask);
    if (what === 'devices' && !heardAt) await h.hold(answer);
    return answer.map((view) => h.view(heardAt ? h.lastHeard(view) : view));
  };
  /** One device as the server says it — or, with it away, as it last said it — with this app's own wrapped in. */
  const viewed = async (view: Promise<DeviceView>): Promise<DeviceView> => h.view(await view);
  const oneOf = async (id: SavedDeviceId): Promise<DeviceView> => {
    try {
      return h.view(await home.devices.get(id));
    } catch (error) {
      if (!(error instanceof ApiError && error.kind === 'unavailable')) throw error;
      const last = [...(h.heard.get<DeviceView[]>('devices')?.body ?? []), ...(h.heard.get<DeviceView[]>('removed')?.body ?? [])].find((device) => device.id === id);
      if (!last) throw error;
      return h.view(h.lastHeard(last));
    }
  };
  /** After the server changed a device's ways: what this app holds, again. */
  const again = async (view: DeviceView): Promise<DeviceView> => {
    await h.refresh();
    return h.view(view);
  };
  /** A device this app holds now: its record and session, or why it cannot be asked. */
  const heldDevice = (id: SavedDeviceId) => {
    const device = h.catalog.active(id)!;
    const session = h.sessions.get(id);
    if (!session) throw new ApiError('unavailable', `${device.name} is not answering: ${h.sessions.health(device).detail}`);
    return { device, session };
  };
  const intent = () => ({ actor: 'user' as const, by: `app:${h.nodeId ?? 'this app'}` });

  // --- setting up a way this app holds ----------------------------------------------
  /** Drafts set up here, and the server's draft each became once read. */
  const drafts = new Map<string, string | null>();
  const local = (id: string) => drafts.has(id);
  const ownDraft = (view: DraftView): DraftView => ({ ...view, heldBy: h.nodeId });

  return {
    /** The server's types, with the ways this app can hold for it: a type this app has installed too, over a way it can hold where it runs. */
    async deviceTypes() {
      const { answer: list } = await h.kept('device-types', () => home.deviceTypes());
      const { transports } = h.installed;
      await transports.startAll(h.transportsHere());
      return {
        ...list,
        types: list.types.map((listing) => {
          const type = h.installed.types.get(listing.id);
          const mine: WayView[] = type
            ? type.connections.filter((method) => holdableHere(h.installed, h.self, method)).map((method) => ({ method: method.id, holder: 'this-node', fits: true, availability: transports.available(method.transport) }))
            : [];
          return { ...listing, ways: [...listing.ways, ...mine] };
        }),
      };
    },

    devices: {
      list: () => listed('devices', () => home.devices.list()),
      removed: () => listed('removed', () => home.devices.removed()),
      get: oneOf,
      update: (id, changes) => viewed(home.devices.update(id, changes)),
      setPicture: (id, picture) => viewed(home.devices.setPicture(id, picture)),
      async remove(id) {
        await home.devices.remove(id);
        await h.forget(id);
      },
      deleteHistory: (id, name) => home.devices.deleteHistory(id, name),
      history: (id, query) => home.devices.history(id, query),
      changes: (id, query) => home.devices.changes(id, query),
      events: (id, limit) => home.devices.events(id, limit),

      /** To a device this app holds: through this app's gateway, as the home's would — checked, confirmed, verified, on the timeline. */
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
      /** A tool this app's session runs, held to its declaration both ways; one that cannot be undone waits for a person's yes. */
      async tool(id, name, body) {
        if (!h.holds(id)) return home.devices.tool(id, name, body);
        const { device, session } = heldDevice(id);
        const spec = h.installed.types.get(device.typeId)?.tools?.[name];
        if (!spec || typeof session.tools?.[name] !== 'function') throw new ApiError('not-found', `${device.name} has no tool called "${name}"`);
        if (body.reading && spec.writes) throw new ApiError('not-allowed', `${name} changes the device: send it as a write`);
        const input = body.input ?? {};
        if (spec.writes && spec.confirm) {
          const subject = subjectOf({ device: device.id, tool: name, input, by: intent().by });
          if (!h.yes.accept(body.confirmation, subject)) throw new ApiError('needs-yes', spec.confirm, { needsConfirmation: h.yes.ask(subject) });
        }
        const record = (kind: string, summary: string) => h.owe('audit', null, { at: new Date().toISOString(), kind, actor: intent().by, resourceKind: 'device', resource: device.id, summary, detail: { tool: name, input } });
        try {
          const answer = await runTool({ deviceName: device.name, name, spec, session, input, readOnly: h.readOnly() && !h.sessions.simulated(device.id) });
          if (spec.writes) record('device.tool', `Ran ${spec.label.toLowerCase()} on "${device.name}"`);
          return answer;
        } catch (error) {
          if (spec.writes) record('device.tool-refused', `${spec.label} on "${device.name}" was refused: ${(error as Error).message}`);
          if (error instanceof ToolRefused) throw new ApiError(TOOL_REFUSAL[error.reason], error.message);
          throw error;
        }
      },
    },

    problems: async (limit) => (await h.kept(`problems:${limit ?? ''}`, () => home.problems(limit))).answer,

    setup: {
      /** A way this app holds is set up here, over its own radio; any other, by the server. */
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
       * Read here, over this app's own radio, and judged by the server
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

      /** Saved by the server — the device, this app's way, its links — and the way's secrets kept here, never sent. */
      async save(id, input) {
        if (!local(id)) return home.setup.save(id, input);
        const judged = drafts.get(id);
        if (!judged) throw new ApiError('conflict', 'Check that it answers first');
        const { draft, secrets } = await h.setup.read(id).catch(() => ({ draft: h.setup.view(id), secrets: {} as Record<string, string> }));
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

    transports: {
      /** The server's, and this app's own: what it holds the server's ways over, here. */
      async list() {
        const { answer: list } = await h.kept('transports', () => home.transports.list());
        const { transports } = h.installed;
        const mine = h.transportsHere().map((id): TransportView => {
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
      /** A way this app holds keeps its secrets here, and they are never sent; any other way's are the server's. */
      async setSecrets(device, connection, secrets) {
        if (!h.owns(connection)) return home.connections.setSecrets(device, connection, secrets);
        const record = h.catalog.active(device);
        const way = h.connections.get(asConnectionId(connection));
        const type = record ? h.installed.types.get(record.typeId) : null;
        const method = type && way ? methodOf(type, way.method) : null;
        const schema = connectionSchema(method, method ? (h.installed.protocols.get(method.protocol) ?? null) : null);
        const refused = Object.keys(secrets).filter((field) => !schema.fields[field] || !isSecretField(schema.fields[field]!));
        if (refused.length) throw new ApiError('invalid', `Not a secret of this connection: ${refused.join(', ')}`);
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
      list: async (filter) => (await h.kept(`automations:${filter?.device ?? ''}`, () => home.automations.list(filter))).answer,
      async get(id) {
        try {
          return await home.automations.get(id);
        } catch (error) {
          const last = error instanceof ApiError && error.kind === 'unavailable' ? h.heard.get<AutomationView[]>('automations:')?.body.find((automation) => automation.id === id) : null;
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
      /** A file, planned by the server; or the home this app kept itself, moving to it. */
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
        const { answer } = await h.kept('policy', () => home.policy.list());
        h.keepPolicy(answer);
        return answer;
      },
      /** Set on the server, and kept here: this app's gateway weighs what it holds by the same values. */
      set: async (name, value) => {
        const values = await home.policy.set(name, value);
        h.keepPolicy(values);
        // What the server answers is how they are now: what is shown while it is away, too.
        h.heard.keep('policy', values);
        return values;
      },
    },

    home: () => home.home(),
    timeline: (query) => home.timeline(query),
    world: () => home.world(),
    vocabulary: () => home.vocabulary(),

    nodes: {
      join: (node) => home.nodes.join(node),
      list: () => home.nodes.list(),
      forget: (id) => home.nodes.forget(id),
    },
    held: {
      readings: (device, upload) => home.held.readings(device, upload),
      store: (device) => home.held.store(device),
      keep: (device, key, entry) => home.held.keep(device, key, entry),
      audit: (app, entries) => home.held.audit(app, entries),
    },

    /**
     * The server's stream, and what this app hears from what it holds: a
     * device this app holds is said by this app — its readings and health
     * first-hand — and the server's word on it, which comes later and second
     * hand, is left out. A change to what this app holds reads the list
     * again, which holds from it again.
     */
    live(listener, options = {}) {
      const outbox = new Outbox();
      let pending: ReturnType<typeof setTimeout> | null = null;
      const flush = () => {
        pending = null;
        if (options.draining && !options.draining()) return schedule();
        for (const update of outbox.take()) listener(update);
      };
      const schedule = () => {
        pending ??= setTimeout(flush, FLUSH_MS);
      };
      const unsubscribe = h.bus.subscribe((message) => {
        outbox.add(message);
        schedule();
      });
      const stream = home.live((update: LiveUpdate) => {
        if ((update.type === 'readings' || update.type === 'health') && h.holds(update.deviceId)) return;
        listener(update);
      }, options);
      return {
        say: (view) => stream.say(view),
        close: () => {
          stream.close();
          unsubscribe();
          if (pending) clearTimeout(pending);
          pending = null;
        },
      };
    },
  };
}
