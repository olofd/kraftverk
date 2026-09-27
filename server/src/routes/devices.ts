import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';

import { savedDeviceId, secretFields, validateConfig as validatePluginConfig } from '@kraftverk/device-sdk';

import { actorOf } from '../auth/routes.ts';
import type { StationSession } from '../connections/manager.ts';
import { STATION_MODELS } from '../devices/catalog.ts';
import { pairedStation, pairStation } from '../devices/relay-pairing.ts';
import { series } from '../history/sampler.ts';
import { PortIdSchema, StationSettingsPatchSchema } from '../types.ts';
import { auditDevice, body, type AppDeps } from './shared.ts';

const STATION_MODEL_IDS = STATION_MODELS.map((model) => model.id) as [string, ...string[]];

/**
 * One list of the things you own: the station, and whatever the installed
 * drivers provide. Described identically, so the app has one card, one detail
 * screen and one chart for all of them.
 */
export function deviceRoutes({ catalog, connections, host, registry, gateway, legacyStation }: AppDeps): Hono {
  const api = new Hono();

  /**
   * What a new device may be.
   *
   * A station's driver is the core; a plug's is an installed grid-relay
   * extension. Anything else used to be stored as given — and since links are
   * opened by type alone, `{ type: 'power-station', driver: 'x' }` got a real
   * hardware session, polling and auto-binding a station, while the list
   * showed "driver x is not installed". The only configuration accepted is
   * the station a station reaches and how; a plug's belongs to its extension.
   */
  const NewDevice = z.discriminatedUnion('type', [
    z.object({
      type: z.literal('power-station'),
      driver: z.literal('core.station'),
      name: z.string().trim().min(1).max(60),
      model: z.enum(STATION_MODEL_IDS).nullish(),
      config: z
        .object({ transport: z.enum(['mqtt', 'ble']).optional(), boundId: z.string().min(1).max(64).optional() })
        .strict()
        .optional(),
    }),
    z.object({
      type: z.literal('smart-plug'),
      driver: z
        .string()
        .refine(
          (driver) => host.all.some((instance) => instance.manifest.id === driver && instance.manifest.kind === 'grid-relay'),
          'No installed extension provides that kind of plug'
        ),
      name: z.string().trim().min(1).max(60),
      model: z.null().optional(),
      config: z.object({}).strict().optional(),
    }),
  ]);

  api.get('/devices', async (c) => c.json({ devices: await registry.all() }));

  // --- the legacy station import ------------------------------------------

  api.get('/migration/station', async (c) => c.json(await legacyStation.offer()));

  api.post('/migration/station/import', async (c) => {
    const { name } = await body(c, z.object({ name: z.string().min(1).max(60).optional() }));
    const record = await legacyStation.accept(name);
    if (!record) throw new HTTPException(409, { message: 'There is no station to import' });
    // The imported station gets its link straight away, as an added one does.
    await connections.sync(catalog.list());
    return c.json(await registry.find(record.id));
  });

  api.post('/migration/station/dismiss', (c) => {
    legacyStation.dismiss();
    return c.json({ ok: true });
  });

  /** What can be added, and what each one needs. Drives the add-device wizard. */
  api.get('/device-types', (c) =>
    c.json({
      types: [
        {
          id: 'power-station',
          label: 'Power station',
          description: 'A Sydpower-stack station: AFERIY, FOSSiBOT, Eco Play, ABOK.',
          icon: 'zap',
          driver: 'core.station',
          models: STATION_MODELS,
          available: true,
          note: 'The server talks to it over WiFi or Bluetooth.',
        },
        ...host.all
          .filter((instance) => instance.manifest.kind === 'grid-relay')
          .map((instance) => ({
            id: instance.manifest.id,
            label: instance.manifest.name,
            description: instance.manifest.description,
            icon: instance.manifest.ui.icon,
            driver: instance.manifest.id,
            models: [],
            available: true,
            note: instance.manifest.setupActions?.length ? 'Finds it on your network and fetches what it needs.' : undefined,
          })),
      ],
    })
  );

  api.post('/devices', async (c) => {
    const input = await body(c, NewDevice);
    const record = catalog.add({ type: input.type, driver: input.driver, name: input.name, model: input.model ?? null, config: input.config });

    auditDevice(c, 'device.added', record.id, `Added "${record.name}" (${record.driver})`, { type: record.type, model: record.model });

    /*
      Pair the relay with the first station added, and record the id. This is
      the one moment the answer is unambiguous, so it is the moment to write it
      down — rather than re-deriving "the only station" at every switch, which
      would quietly become the wrong station the day a second is added.
    */
    if (record.type === 'power-station' && !pairedStation()) {
      pairStation(record.id);
      auditDevice(c, 'relay.paired', record.id, `The grid relay is assumed to feed "${record.name}"`);
    }

    // Adding a station opens its link, rather than waiting for a restart.
    await connections.sync(catalog.list());
    return c.json(await registry.find(record.id));
  });

  api.get('/devices/:id', async (c) => {
    const found = await registry.find(savedDeviceId(c.req.param('id')));
    if (!found) throw new HTTPException(404, { message: 'No such device' });
    return c.json(found);
  });

  api.patch('/devices/:id', async (c) => {
    const id = savedDeviceId(c.req.param('id'));
    /*
      A name and a model, and nothing else. Configuration used to be writable
      here, which rewrote which station a device was bound to without going
      through `bind` and its check that no other device holds that station.
    */
    const changes = await body(
      c,
      z.object({ name: z.string().trim().min(1).max(60).optional(), model: z.enum(STATION_MODEL_IDS).nullish() }).strict()
    );

    const before = catalog.get(id);
    if (!before) throw new HTTPException(404, { message: 'No such device' });
    if (changes.model !== undefined && before.type !== 'power-station') {
      throw new HTTPException(400, { message: 'Only a power station has a model to choose' });
    }
    const updated = catalog.update(id, changes);
    if (!updated) throw new HTTPException(404, { message: 'No such device' });

    if (updated.name !== before.name) auditDevice(c, 'device.renamed', id, `Renamed "${before.name}" to "${updated.name}"`);
    if (updated.model !== before.model) auditDevice(c, 'device.remodelled', id, `${updated.name} is now a ${updated.model ?? 'unknown model'}`);

    return c.json(await registry.find(id));
  });

  api.delete('/devices/:id', async (c) => {
    const id = savedDeviceId(c.req.param('id'));
    const record = catalog.get(id);
    if (!record) throw new HTTPException(404, { message: 'No such device' });

    // Written before the delete, so the entry survives even if the transaction
    // does not — and so the record's own details are still there to describe.
    auditDevice(c, 'device.forgotten', id, `Forgot "${record.name}" and everything it had recorded`, {
      type: record.type,
      driver: record.driver,
      model: record.model,
      addedAt: record.addedAt,
    });

    catalog.remove(id);

    // A pairing that points at a device you no longer own is worse than none.
    if (pairedStation() === id) {
      pairStation(null);
      auditDevice(c, 'relay.unpaired', id, 'The station the grid relay fed was forgotten');
    }

    // Forgetting a device closes its link.
    await connections.sync(catalog.list());
    return c.json({ ok: true });
  });

  // --- one P280, by device id ---------------------------------------------
  //
  // The station's rich telemetry does not fit the generic `Reading[]` shape:
  // the energy-flow view needs ports, firmware, link state and a dozen
  // quantities in their model's own units. So it is served under the device's
  // namespace, and the server checks the device really is a station.

  /** Resolves a saved station and its live session, or explains which is missing. */
  const stationDevice = (c: Context): StationSession => {
    const id = savedDeviceId(c.req.param('id') ?? '');
    const record = catalog.get(id);
    if (!record) throw new HTTPException(404, { message: 'No such device' });
    if (record.driver !== 'core.station') throw new HTTPException(400, { message: 'That device is not a power station' });
    const session = connections.get(id);
    if (!session) throw new HTTPException(409, { message: connections.refusal(id) ?? 'The server is not holding a link to that device' });
    return session;
  };

  api.get('/devices/:id/p280/state', (c) => {
    const session = stationDevice(c);
    return c.json({
      status: session.driver.status(),
      settings: session.driver.settings(),
      // Facts about *this* connection rather than about the server as a whole.
      readOnly: connections.readOnly,
      link: session.kind,
    });
  });

  api.patch('/devices/:id/p280/settings', async (c) => {
    const session = stationDevice(c);
    // The register-68 guard and every other bound stand on this path.
    const patch = await body(c, StationSettingsPatchSchema);
    const result = await session.driver.applySettings(patch);
    auditDevice(c, 'station.settings', session.deviceId, `Changed ${Object.keys(patch).join(', ') || 'nothing'} on the station`, patch);
    return c.json(result);
  });

  /**
   * A device's own settings: what it remembers, not how we reach it.
   *
   * The schema comes from the device, so the app renders the P280's charge
   * limit and a future plug's timers through the same code — and a setting
   * that can damage the hardware is marked as such by the device.
   */
  api.get('/devices/:id/settings', async (c) => {
    const found = await registry.find(savedDeviceId(c.req.param('id')));
    if (!found) throw new HTTPException(404, { message: 'No such device' });
    if (!found.settings) return c.json({ schema: null, values: {}, dangerous: [] });
    return c.json({ schema: found.settings.schema, dangerous: found.settings.dangerous ?? [], values: registry.readSettings(found.record) });
  });

  api.patch('/devices/:id/settings', async (c) => {
    const id = savedDeviceId(c.req.param('id'));
    const found = await registry.find(id);
    if (!found?.settings) throw new HTTPException(404, { message: 'That device has no settings' });

    const patch = await body(c, z.record(z.string(), z.unknown()));
    const validated = validatePluginConfig(found.settings.schema, { ...registry.readSettings(found.record), ...patch });
    if (!validated.ok) return c.json({ error: 'Validation failed', issues: validated.issues }, 400);

    // Only what was asked for is sent: applying the full set would rewrite
    // every register on the station to change one of them.
    const changed = Object.fromEntries(Object.keys(patch).map((key) => [key, validated.value[key]]));
    const values = await registry.writeSettings(found.record, changed);
    // Secret fields are never written to the timeline, only that they changed.
    const secret = new Set(secretFields(found.settings.schema));
    auditDevice(
      c,
      // One kind for a station's settings, whichever route changed them.
      found.record.driver === 'core.station' ? 'station.settings' : 'device.settings',
      id,
      `Changed ${Object.keys(changed).join(', ')} on "${found.record.name}"`,
      Object.fromEntries(Object.entries(changed).map(([key, value]) => [key, secret.has(key) ? '(secret)' : value]))
    );
    return c.json({ values });
  });

  /**
   * One measurement over time, thinned server-side: a fortnight of minute
   * samples is far more points than a phone-sized chart can show.
   */
  api.get('/devices/:id/history', (c) => {
    const id = savedDeviceId(c.req.param('id'));
    // An unknown device answered 200 with an empty series, which is
    // indistinguishable from one that has not recorded anything yet.
    if (!catalog.get(id)) throw new HTTPException(404, { message: 'No such device' });

    const { key, hours, points } = z
      .object({
        key: z.string().min(1).max(64),
        hours: z.coerce.number().min(0.5).max(24 * 14).default(24),
        points: z.coerce.number().int().min(20).max(1000).default(240),
      })
      .parse({ key: c.req.query('key'), hours: c.req.query('hours') ?? 24, points: c.req.query('points') ?? 240 });

    const to = new Date();
    const from = new Date(to.getTime() - hours * 3_600_000);
    return c.json({ deviceId: id, key, from: from.toISOString(), to: to.toISOString(), points: series(id, key, from.toISOString(), to.toISOString(), points) });
  });

  /**
   * Invokes a device control. Anything physical goes through the action
   * gateway, so a control on a device screen has exactly the authority a
   * manual switch does — no more.
   */
  api.post('/devices/:id/control/:control', async (c) => {
    const deviceId = savedDeviceId(c.req.param('id'));
    const controlId = c.req.param('control');
    const found = await registry.find(deviceId);
    if (!found) throw new HTTPException(404, { message: 'No such device' });

    const control = found.controls.find((candidate) => candidate.id === controlId);
    if (!control) throw new HTTPException(404, { message: 'No such control' });

    const { value, confirmation } = await body(
      c,
      z.object({ value: z.union([z.boolean(), z.number(), z.string().max(64)]), confirmation: z.string().max(64).optional() })
    );

    // The station's own ports go through *this device's* session.
    if (found.record.driver === 'core.station') {
      const session = connections.get(deviceId);
      if (!session) {
        throw new HTTPException(409, { message: connections.refusal(deviceId) ?? 'The server is not holding a link to that device' });
      }
      const port = PortIdSchema.parse(controlId);
      const result = await session.driver.setPort(port, value === true);
      auditDevice(c, 'station.port', found.record.id, `Switched ${port} ${value === true ? 'on' : 'off'} on "${found.record.name}"`);
      return c.json(result);
    }

    if (control.capability === 'switch') {
      /*
        The gateway switches the relay — whichever plug is set up as it. With
        two relay extensions, the switch on one plug's card flipped the other;
        a tap on this card must act on this plug, or not at all.
      */
      const relay = gateway.provider();
      if (!relay || relay.id !== found.record.driver) {
        throw new HTTPException(409, {
          message: relay
            ? `This plug is not the grid relay — ${relay.id} is. Choose the relay under Extensions.`
            : 'No plug is set up as the grid relay yet.',
        });
      }
      const result = await gateway.execute({
        desired: value === true,
        reason: `${control.label} switched from the device screen`,
        actor: 'user',
        by: actorOf(c),
        confirmation,
      });
      return c.json(result, result.outcome === 'refused' ? 409 : 200);
    }

    throw new HTTPException(400, { message: `${control.capability} cannot be invoked yet` });
  });

  return api;
}
