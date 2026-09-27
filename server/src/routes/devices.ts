import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';

import {
  describeDeviceType,
  savedDeviceId,
  secretFields,
  validateConfig,
  type DeviceTypeView,
  type SavedDeviceId,
} from '@kraftverk/device-sdk';

import { actorOf } from '../auth/routes.ts';
import type { DeviceRecord } from '../devices/catalog.ts';
import { pairedStation, pairStation } from '../devices/relay-pairing.ts';
import { stationOf } from '../devices/station-bridge.ts';
import type { StationDriver } from '../drivers/types.ts';
import { series } from '../history/sampler.ts';
import { StationSettingsPatchSchema } from '../types.ts';
import { auditDevice, body, type AppDeps } from './shared.ts';

/**
 * A v1 extension, listed beside the device types while plugins still provide
 * devices (until step 5). It is set up under Extensions, not by a guide.
 */
export type ExtensionTypeView = DeviceTypeView & { extension: true };

/**
 * The devices you own, whatever they are. Described identically, so the app has
 * one card, one detail screen and one chart for all of them.
 */
export function deviceRoutes({ config, catalog, types, sessions, host, registry, gateway, legacyStation }: AppDeps): Hono {
  const api = new Hono();

  /** Extensions that provide a device, as types the add screen can list. */
  const extensionTypes = (): ExtensionTypeView[] =>
    host.all
      .filter((instance) => instance.manifest.kind === 'grid-relay')
      .map(({ manifest }) => ({
        id: manifest.id,
        kind: 'hardware',
        meta: { name: manifest.name, description: manifest.description, category: 'smart-plug', support: 'community', icon: manifest.ui.icon },
        protocols: [],
        capabilities: ['switch', 'powerMeter'],
        telemetry: [],
        controls: [],
        settings: null,
        config: { fields: {} },
        setup: [],
        extension: true,
      }));

  /**
   * What can be added: every installed device type, found rather than listed.
   * A package added to `packages/devices` appears here with no other change.
   */
  api.get('/device-types', (c) =>
    c.json({
      types: [...types.all().map(describeDeviceType), ...extensionTypes()],
      /** Packages that were found and refused, and why: for whoever is writing one. */
      refused: types.refused,
    })
  );

  /*
    Pair the relay with the first device you own that reports an AC input, and
    record the id. This is the one moment the answer is unambiguous, so it is
    the moment to write it down — rather than re-deriving "the only station" at
    every switch, which would quietly become the wrong one the day a second is
    added.

    Both ways a station arrives go through here. An imported one used to be
    left unpaired, and every switch of the relay was then refused.
  */
  const pairFirstStation = (c: Context, record: DeviceRecord) => {
    if (!sessions.typeOf(record)?.capabilities.includes('acInput') || pairedStation()) return;
    pairStation(record.id);
    auditDevice(c, 'relay.paired', record.id, `The grid relay is assumed to feed "${record.name}"`);
  };

  api.get('/devices', async (c) => c.json({ devices: await registry.all() }));

  // --- the legacy station import ------------------------------------------

  api.get('/migration/station', async (c) => c.json(await legacyStation.offer()));

  api.post('/migration/station/import', async (c) => {
    const { name } = await body(c, z.object({ name: z.string().min(1).max(60).optional() }));
    const record = await legacyStation.accept(name, actorOf(c));
    if (!record) throw new HTTPException(409, { message: 'There is no station to import' });
    // The imported station is paired and gets its session straight away, as an added one does.
    pairFirstStation(c, record);
    await sessions.sync(catalog.list());
    return c.json(await registry.find(record.id));
  });

  api.post('/migration/station/dismiss', (c) => {
    legacyStation.dismiss();
    return c.json({ ok: true });
  });

  // --- adding, renaming, forgetting ---------------------------------------

  api.post('/devices', async (c) => {
    const input = await body(
      c,
      z
        .object({
          typeId: z.string().min(1).max(80),
          name: z.string().trim().min(1).max(60),
          config: z.record(z.string(), z.unknown()).optional(),
        })
        .strict()
    );

    const type = types.get(input.typeId);
    const extension = type ? null : host.instance(input.typeId);
    let added;

    if (type) {
      /*
        Validated against the type's own config schema. Secrets are refused
        here for now: they need a home per device, which the catalog
        migration gives them (step 4) — until then a secret sent here would
        have nowhere safe to go.
      */
      const secrets = secretFields(type.config);
      const given = input.config ?? {};
      if (secrets.some((field) => given[field] !== undefined)) {
        throw new HTTPException(400, { message: 'Secrets cannot be set here yet' });
      }
      const validated = validateConfig(type.config, given);
      if (!validated.ok) throw new HTTPException(400, { message: validated.issues.map((issue) => issue.message).join('; ') });

      added = catalog.add({ type: type.meta.category, driver: type.id, name: input.name, config: validated.value });
    } else if (extension?.manifest.kind === 'grid-relay') {
      // A v1 extension's device: its configuration lives with the extension.
      if (input.config && Object.keys(input.config).length) {
        throw new HTTPException(400, { message: 'That device is configured under Extensions' });
      }
      added = catalog.add({ type: 'smart-plug', driver: extension.manifest.id, name: input.name });
    } else {
      throw new HTTPException(400, { message: `Nothing installed here provides "${input.typeId}"` });
    }

    auditDevice(c, 'device.added', added.id, `Added "${added.name}" (${input.typeId})`, { typeId: input.typeId });

    pairFirstStation(c, added);

    // Adding a device opens its session, rather than waiting for a restart.
    await sessions.sync(catalog.list());
    return c.json(await registry.find(added.id));
  });

  api.get('/devices/:id', async (c) => {
    const found = await registry.find(savedDeviceId(c.req.param('id')));
    if (!found) throw new HTTPException(404, { message: 'No such device' });
    return c.json(found);
  });

  api.patch('/devices/:id', async (c) => {
    const id = savedDeviceId(c.req.param('id'));
    /*
      A name, and nothing else. What a device *is* is its type, which does not
      change; how it is reached is its config, which goes through its own route
      and its own checks — binding a station through here once skipped the
      check that no other device already holds it.
    */
    const changes = await body(c, z.object({ name: z.string().trim().min(1).max(60) }).strict());

    const before = catalog.get(id);
    if (!before) throw new HTTPException(404, { message: 'No such device' });
    const updated = catalog.update(id, changes);
    if (!updated) throw new HTTPException(404, { message: 'No such device' });

    if (updated.name !== before.name) auditDevice(c, 'device.renamed', id, `Renamed "${before.name}" to "${updated.name}"`);
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
      addedAt: record.addedAt,
    });

    catalog.remove(id);

    // A pairing that points at a device you no longer own is worse than none.
    if (pairedStation() === id) {
      pairStation(null);
      auditDevice(c, 'relay.unpaired', id, 'The station the grid relay fed was forgotten');
    }

    // Forgetting a device closes its session.
    await sessions.sync(catalog.list());
    return c.json({ ok: true });
  });

  // --- a station's own state, by device id --------------------------------
  //
  // The station dashboard needs more than readings — ports, firmware, link
  // state — so it has routes of its own. Transitional: they reach the station
  // through the one bridge there is (`stationOf`), and become routes the
  // station's package provides in step 7.

  /** A saved station's driver, or which of the two is missing. */
  const stationDevice = (c: Context): { id: SavedDeviceId; station: StationDriver } => {
    const id = savedDeviceId(c.req.param('id') ?? '');
    const record = catalog.get(id);
    if (!record) throw new HTTPException(404, { message: 'No such device' });
    const session = sessions.get(id);
    if (!session) throw new HTTPException(409, { message: sessions.health(record).detail });
    if (!('station' in session)) throw new HTTPException(400, { message: 'That device is not a power station' });
    const station = stationOf(session);
    if (!station) throw new HTTPException(409, { message: session.health().detail });
    return { id, station };
  };

  api.get('/devices/:id/p280/state', (c) => {
    const { id, station } = stationDevice(c);
    return c.json({
      status: station.status(),
      settings: station.settings(),
      // Facts about *this* connection rather than about the server as a whole.
      readOnly: config.readOnly,
      link: sessions.get(id)?.health().transport ?? null,
    });
  });

  api.patch('/devices/:id/p280/settings', async (c) => {
    const { id, station } = stationDevice(c);
    // The register-68 guard and every other bound stand on this path.
    const patch = await body(c, StationSettingsPatchSchema);
    const result = await station.applySettings(patch);
    auditDevice(c, 'device.settings', id, `Changed ${Object.keys(patch).join(', ') || 'nothing'} on the station`, patch);
    return c.json(result);
  });

  // --- settings, history and controls: the same for every device ---------

  /**
   * A device's own settings: what it remembers, not how we reach it. The
   * schema comes from the device, so the app renders every device's settings
   * through the same code, and a setting that can damage the hardware is
   * marked as such by the device.
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
    const validated = validateConfig(found.settings.schema, { ...registry.readSettings(found.record), ...patch });
    if (!validated.ok) return c.json({ error: 'Validation failed', issues: validated.issues }, 400);

    // Only what was asked for is sent: applying the full set would rewrite
    // every register on a station to change one of them.
    const changed = Object.fromEntries(Object.keys(patch).map((key) => [key, validated.value[key]]));
    const values = await registry.writeSettings(found.record, changed).catch((error: unknown) => {
      throw new HTTPException(409, { message: (error as Error).message });
    });
    // Secret fields are never written to the timeline, only that they changed.
    const secret = new Set(secretFields(found.settings.schema));
    auditDevice(
      c,
      'device.settings',
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
   * Invokes a device control: a capability command, on this device.
   *
   * A control on a device screen has exactly the authority a manual switch
   * does, and no more. Switching a relay goes through the action gateway; the
   * rest of the gateway's reach — every command, one path — is step 6.
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

    if (found.typeId) {
      const session = sessions.get(deviceId);
      if (!session) throw new HTTPException(409, { message: found.health.detail });
      if (config.readOnly) throw new HTTPException(423, { message: 'The server is in read-only mode' });

      if (control.capability === 'outlets') {
        const outlets = session.capability('outlets');
        if (!outlets) throw new HTTPException(409, { message: 'Its outlets cannot be switched right now' });
        const on = value === true;
        const result = await outlets.set(control.target ?? control.id, on);
        if (!result.accepted) throw new HTTPException(409, { message: result.error });
        auditDevice(c, 'device.outlet', deviceId, `Switched ${control.label} ${on ? 'on' : 'off'} on "${found.name}"`);
        return c.json({ ok: true });
      }

      throw new HTTPException(400, { message: `${control.capability} cannot be invoked here yet` });
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
