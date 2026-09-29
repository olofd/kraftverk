import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';

import type { AttributeWrite, CommandBody, DeviceHistory, DeviceTypeListing } from '@kraftverk/api-contract';
import { CATEGORIES, describeDeviceType, isCapability, type Availability } from '@kraftverk/device-sdk';

import { actorOf } from '../auth/routes.ts';
import { resolutionOf, series } from '../history/sampler.ts';
import { auditDevice, body, deviceOr404, type AppDeps } from './shared.ts';

/**
 * The devices you own, whatever they are. Described identically, so the app has
 * one card, one detail screen and one chart for all of them.
 */
export function deviceRoutes({ config, catalog, types, protocols, transports, sessions, registry, gateway, events }: AppDeps): Hono {
  const api = new Hono();

  /**
   * Whether this server can hold a connection over a method. With the
   * simulator every method can be tried; otherwise its protocol must be
   * installed, and its transport enabled here and running.
   */
  const serverHolds = (protocolId: string, transportId: string): Availability => {
    const protocol = protocols.get(protocolId);
    if (!protocol?.bindings[transportId]) return { ok: false, reason: 'This server cannot reach devices this way: it needs updating' };
    if (config.simulate) return { ok: true };
    return transports.available(transportId);
  };

  /**
   * What can be added: every installed device type, found rather than listed,
   * with the categories they are listed under. A package added to
   * `packages/devices` appears here with no other change.
   */
  api.get('/device-types', (c) => {
    const listing: DeviceTypeListing[] = types.all().map((type) => ({
      ...describeDeviceType(type),
      availability: Object.fromEntries(type.connections.map((method) => [method.id, { server: serverHolds(method.protocol, method.transport) }])),
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
    if (updated.name !== before.name) auditDevice(c, 'device.renamed', before.id, `Renamed "${before.name}" to "${updated.name}"`);
    return c.json(registry.find(before.id));
  });

  /**
   * Removes a device, keeping its history. Its connections and links go; adding
   * the same device again offers to bring it all back.
   */
  api.delete('/devices/:id', async (c) => {
    const record = deviceOr404(catalog, c.req.param('id'));
    catalog.remove(record.id);
    auditDevice(c, 'device.removed', record.id, `Removed "${record.name}". Its history is kept.`, { typeId: record.typeId, identity: record.identity });
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
    auditDevice(c, 'device.history-deleted', record.id, `Deleted "${record.name}" and everything it had recorded`, {
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
      z.object({ patch: z.record(z.string().max(64), z.union([z.string().max(4096), z.number(), z.boolean(), z.null()])), confirmation: z.string().max(20).optional() }).strict()
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
    const { key, hours, points } = z
      .object({
        key: z.string().min(1).max(64),
        hours: z.coerce.number().min(0.5).max(24 * 730).default(24),
        points: z.coerce.number().int().min(20).max(1000).default(240),
      })
      .parse({ key: c.req.query('key'), hours: c.req.query('hours') ?? 24, points: c.req.query('points') ?? 240 });

    const to = new Date().toISOString();
    const from = new Date(Date.now() - hours * 3_600_000).toISOString();
    const history: DeviceHistory = { deviceId: record.id, key, from, to, resolution: resolutionOf(from, to), points: series(record.id, key, from, to, points) };
    return c.json(history);
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
    if (!isCapability(capability)) throw new HTTPException(404, { message: `"${capability}" is not a capability` });

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
   * A device type's own tools: a register dump, a raw frame. The core serves
   * them, so none of them is a route of its own. Reading is a GET; anything
   * that `writes` is a POST, refused while read-only, and audited.
   */
  const advancedOf = (id: string | undefined, name: string) => {
    const record = deviceOr404(catalog, id);
    const session = sessions.get(record.id);
    if (!session) throw new HTTPException(409, { message: sessions.health(record).detail });
    const action = session.advanced?.[name];
    if (!action) throw new HTTPException(404, { message: `${record.name} has no tool called "${name}"` });
    return { record, action };
  };

  api.get('/devices/:id/advanced/:name', async (c) => {
    const name = c.req.param('name');
    const { action } = advancedOf(c.req.param('id'), name);
    if (action.writes) throw new HTTPException(405, { message: `${name} changes the device: POST it` });
    return c.json(await action.run(c.req.query()));
  });

  api.post('/devices/:id/advanced/:name', async (c) => {
    const name = c.req.param('name');
    const { record, action } = advancedOf(c.req.param('id'), name);
    const input = await body(c, z.record(z.string(), z.unknown()));
    if (action.writes && !action.honoursReadOnly && config.readOnly) throw new HTTPException(423, { message: 'The server is in read-only mode' });
    try {
      const result = await action.run(input);
      if (action.writes) auditDevice(c, 'device.advanced', record.id, `Ran ${name} on "${record.name}"`, { input });
      return c.json(result);
    } catch (error) {
      // A tool refusing is worth a line too: an attempt at the brick write is what the timeline is for.
      if (action.writes) auditDevice(c, 'device.advanced-refused', record.id, `${name} on "${record.name}" was refused: ${(error as Error).message}`, { input });
      throw new HTTPException(409, { message: (error as Error).message });
    }
  });

  return api;
}
