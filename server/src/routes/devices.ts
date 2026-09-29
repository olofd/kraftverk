import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';

import type { AttributeWrite, CommandBody, DeviceChanges, DeviceHistory, DeviceTypeListing } from '@kraftverk/api-contract';
import { CATEGORIES, capabilityIn, describeDeviceType, isSimulated, methodsOf, type Availability, type ConnectionMethod } from '@kraftverk/device-sdk';
import { runTool, ToolRefused, type ToolRefusal } from '@kraftverk/holder';

import { actorOf } from '../auth/routes.ts';
import { changesOf } from '../history/changes.ts';
import { resolutionOf, series } from '../history/sampler.ts';
import { auditAbout, body, deviceOr404, type AppDeps } from './shared.ts';

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
  if (query.from && query.hours !== undefined) throw new HTTPException(400, { message: 'Ask for from and to, or hours: not both' });
  if (!(from < to)) throw new HTTPException(400, { message: 'The span ends before it begins' });
  if (to.getTime() - from.getTime() > MAX_SPAN_MS) throw new HTTPException(400, { message: 'History is kept for two years: ask for less' });
  return { from: from.toISOString(), to: to.toISOString() };
}

/**
 * The devices you own, whatever they are. Described identically, so the app has
 * one card, one detail screen and one chart for all of them.
 */
export function deviceRoutes({ config, catalog, types, protocols, transports, sessions, registry, gateway, events }: AppDeps): Hono {
  const api = new Hono();

  /**
   * Whether this server can hold a connection over a method: a simulated one
   * always; otherwise its protocol must be installed, and its transport able
   * to run here.
   */
  const serverHolds = (method: ConnectionMethod): Availability => {
    if (isSimulated(method)) return { ok: true };
    const protocol = protocols.get(method.protocol);
    if (!protocol?.bindings[method.transport]) return { ok: false, reason: 'This server cannot reach devices this way: it needs updating' };
    return transports.available(method.transport);
  };

  /**
   * What can be added: every installed device type, found rather than listed,
   * with the categories they are listed under. A package added to
   * `packages/devices` appears here with no other change.
   */
  api.get('/device-types', (c) => {
    const listing: DeviceTypeListing[] = types.all().map((type) => ({
      ...describeDeviceType(type),
      availability: Object.fromEntries(methodsOf(type).map((method) => [method.id, { server: serverHolds(method) }])),
      warnings: types.warnings(type.id),
    }));
    return c.json({
      categories: CATEGORIES,
      types: listing,
      transports: transports.definitions(),
      /** Packages that were found and refused, and why: for whoever is writing one. */
      refused: { types: types.refused, protocols: protocols.refused, transports: transports.refused },
    });
  });

  api.get('/devices', (c) => c.json({ devices: registry.all() }));

  /** Removed devices, kept with their history: to bring back by adding again, or to delete. */
  api.get('/devices/removed', (c) => c.json({ devices: registry.removed() }));

  api.get('/devices/:id', (c) => {
    const found = registry.find(deviceOr404(catalog, c.req.param('id'), { removed: true }).id);
    if (!found) throw new HTTPException(404, { message: 'No such device' });
    return c.json(found);
  });

  api.patch('/devices/:id', async (c) => {
    const before = deviceOr404(catalog, c.req.param('id'));
    /*
      A name, and nothing else. What a device *is* is its type, which does not
      change; how it is reached is its connections, which have routes of their
      own and checks of their own.
    */
    const changes = await body(c, z.object({ name: z.string().trim().min(1).max(60) }).strict());
    const updated = catalog.update(before.id, changes);
    if (!updated) throw new HTTPException(404, { message: 'No such device' });
    if (updated.name !== before.name) auditAbout(c, 'device.renamed', 'device', before.id, `Renamed "${before.name}" to "${updated.name}"`);
    return c.json(registry.find(before.id));
  });

  /**
   * Removes a device, keeping its history. Its connections and links go; adding
   * the same device again offers to bring it all back.
   */
  api.delete('/devices/:id', async (c) => {
    const record = deviceOr404(catalog, c.req.param('id'));
    catalog.remove(record.id);
    auditAbout(c, 'device.removed', 'device', record.id, `Removed "${record.name}". Its history is kept.`, { typeId: record.typeId, identity: record.identity });
    // Removing a device closes its session.
    await sessions.sync(catalog.list());
    return c.json({ ok: true });
  });

  /**
   * Deletes a removed device and everything it recorded. Only a removed one,
   * and only when its name is typed back: nothing else here is irreversible.
   */
  api.post('/devices/:id/delete-history', async (c) => {
    const record = deviceOr404(catalog, c.req.param('id'), { removed: true });
    if (!record.removedAt) throw new HTTPException(409, { message: 'Remove the device first' });
    const { name } = await body(c, z.object({ name: z.string().max(60) }).strict());
    if (name.trim() !== record.name) throw new HTTPException(400, { message: `Type "${record.name}" to confirm` });

    // Written before the delete, so the entry survives whatever happens to the transaction.
    auditAbout(c, 'device.history-deleted', 'device', record.id, `Deleted "${record.name}" and everything it had recorded`, {
      typeId: record.typeId,
      identity: record.identity,
      addedAt: record.addedAt,
      removedAt: record.removedAt,
    });
    const { samples } = catalog.deleteForever(record.id);
    return c.json({ ok: true, samples });
  });

  // --- settings, history, events and commands: the same for every device ---

  /**
   * Writes what a device remembers — the attributes its description says can
   * be written, its settings — through the gateway, like a command: held to
   * their types, refused while read-only, confirmed for one that can damage
   * the hardware, verified by reading it back, and audited. A refusal is an
   * answer (409), with `needsConfirmation` when a person only has to say yes.
   */
  api.patch('/devices/:id/attributes', async (c) => {
    const record = deviceOr404(catalog, c.req.param('id'));
    const input: AttributeWrite = await body(
      c,
      z.object({ patch: z.record(z.string().max(64), z.union([z.string().max(4096), z.number(), z.boolean(), z.null()])), confirmation: z.string().max(64).optional() }).strict()
    );
    const result = await gateway.write({ deviceId: record.id, patch: input.patch, actor: 'user', by: actorOf(c), confirmation: input.confirmation });
    return c.json(result, result.outcome === 'verified' || result.outcome === 'unverified' ? 200 : 409);
  });

  /** What a device said happened, newest first. A removed device's are still there to look at. */
  api.get('/devices/:id/events', (c) => {
    const record = deviceOr404(catalog, c.req.param('id'), { removed: true });
    const limit = z.coerce.number().int().min(1).max(500).default(100).parse(c.req.query('limit') ?? 100);
    return c.json({ events: events.recent(record.id, limit) });
  });

  /**
   * One measurement over time, thinned server-side: a fortnight of minute
   * samples is far more points than a phone-sized chart can show. A removed
   * device's history is still there to look at.
   */
  api.get('/devices/:id/history', (c) => {
    const record = deviceOr404(catalog, c.req.param('id'), { removed: true });
    const { key, points, ...span } = z
      .object({
        key: z.string().min(1).max(64),
        hours: z.coerce.number().min(0.5).max(24 * 730).optional(),
        from: z.iso.datetime({ offset: true }).optional(),
        to: z.iso.datetime({ offset: true }).optional(),
        points: z.coerce.number().int().min(20).max(1000).default(240),
      })
      .strict()
      .parse(c.req.query());
    const { from, to } = spanOf(span);
    const history: DeviceHistory = { deviceId: record.id, key, from, to, resolution: resolutionOf(from, to), points: series(record.id, key, from, to, points) };
    return c.json(history);
  });

  /**
   * Every change of an on/off or an enum in a span, exactly when it happened —
   * what a timeline draws, where a chart of means would blur a switch flicked
   * between two samples into nothing.
   */
  api.get('/devices/:id/changes', (c) => {
    const record = deviceOr404(catalog, c.req.param('id'), { removed: true });
    const { key, ...span } = z
      .object({
        key: z.string().min(1).max(64).optional(),
        hours: z.coerce.number().min(0.5).max(24 * 730).optional(),
        from: z.iso.datetime({ offset: true }).optional(),
        to: z.iso.datetime({ offset: true }).optional(),
      })
      .strict()
      .parse(c.req.query());
    const { from, to } = spanOf(span);
    const changes: DeviceChanges = { deviceId: record.id, from, to, changes: changesOf(record.id, sessions.description(record), { from, to, key }) };
    return c.json(changes);
  });

  /**
   * A command to one part of a device: every one goes through here, and so
   * through the action gateway, which checks the part offers the capability
   * and the arguments are the command's own. A control on a screen is only a
   * view of one of these, with exactly the authority a manual switch has.
   *
   * A refusal is an answer, not an error: 409 with the gateway's verdict, which
   * says `needsConfirmation` when a person only has to confirm it.
   */
  api.post('/devices/:id/parts/:part/commands/:capability/:command', async (c) => {
    const record = deviceOr404(catalog, c.req.param('id'));
    const capability = c.req.param('capability');
    // The library's, or one the device's own description declares.
    if (!capabilityIn(sessions.description(record), capability)) throw new HTTPException(404, { message: `"${capability}" is not a capability of ${record.name}` });

    const input: CommandBody = await body(
      c,
      z
        .object({
          args: z.record(z.string().max(64), z.union([z.string().max(4096), z.number(), z.boolean(), z.null()])),
          confirmation: z.string().max(64).optional(),
          reason: z.string().min(1).max(200).optional(),
        })
        .strict()
    );

    const result = await gateway.execute({
      deviceId: record.id,
      part: c.req.param('part'),
      capability,
      command: c.req.param('command'),
      args: input.args,
      reason: input.reason ?? 'From the device screen',
      actor: 'user',
      by: actorOf(c),
      confirmation: input.confirmation,
    });
    return c.json(result, result.outcome === 'refused' ? 409 : 200);
  });

  /**
   * A device type's own tools, declared as data: a register dump, a raw frame.
   * The core serves them, so none of them is a route of its own; the holder
   * checks each one's input against what it asks for and its answer against
   * what it declares. One that only reads is a GET, its input in the query;
   * one that `writes` is a POST, refused while read-only, and audited.
   */
  const STATUS: Record<ToolRefusal, 400 | 404 | 409 | 423 | 502> = { missing: 404, input: 400, 'read-only': 423, failed: 409, answer: 502 };

  const toolOf = (id: string | undefined, name: string) => {
    const record = deviceOr404(catalog, id);
    const session = sessions.get(record.id);
    if (!session) throw new HTTPException(409, { message: sessions.health(record).detail });
    const spec = sessions.typeOf(record)?.tools?.[name];
    if (!spec || typeof session.tools?.[name] !== 'function') throw new HTTPException(404, { message: `${record.name} has no tool called "${name}"` });
    return { record, session, spec };
  };

  const run = async (c: Parameters<typeof auditAbout>[0], id: string | undefined, name: string, input: unknown): Promise<unknown> => {
    const { record, session, spec } = toolOf(id, name);
    try {
      const answer = await runTool({ deviceName: record.name, name, spec, session, input, readOnly: config.readOnly && !sessions.simulated(record.id) });
      if (spec.writes) auditAbout(c, 'device.tool', 'device', record.id, `Ran ${spec.label.toLowerCase()} on "${record.name}"`, { tool: name, input });
      return answer;
    } catch (error) {
      // A tool refusing is worth a line too: an attempt at the brick write is what the timeline is for.
      if (spec.writes) auditAbout(c, 'device.tool-refused', 'device', record.id, `${spec.label} on "${record.name}" was refused: ${(error as Error).message}`, { tool: name, input });
      if (error instanceof ToolRefused) throw new HTTPException(STATUS[error.reason], { message: error.message });
      throw error;
    }
  };

  api.get('/devices/:id/tools/:name', async (c) => {
    const name = c.req.param('name');
    const { spec } = toolOf(c.req.param('id'), name);
    if (spec.writes) throw new HTTPException(405, { message: `${name} changes the device: POST it` });
    return c.json(await run(c, c.req.param('id'), name, c.req.query()));
  });

  api.post('/devices/:id/tools/:name', async (c) => {
    const input = await body(c, z.record(z.string().max(64), z.union([z.string().max(4096), z.number(), z.boolean(), z.null()])));
    return c.json(await run(c, c.req.param('id'), c.req.param('name'), input));
  });

  return api;
}
