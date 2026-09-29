import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';

import { isLinkKind, isSecretField, linkFits, linkKindSpec, MAIN_PART, partsOf, savedDeviceId } from '@kraftverk/device-sdk';

import { userOf } from '../auth/routes.ts';
import { connectionSchema } from '../devices/setup/index.ts';
import { auditAbout, body, deviceOr404, type AppDeps } from './shared.ts';

/**
 * How each device is reached, how devices fit the house, and the phones and
 * browsers that can hold a connection (docs/DATA-MODEL.md §4).
 *
 * A connection is added by the setup flow, never here: adding one has to
 * find the device, and that is what setup is.
 */
export function connectionRoutes({ catalog, connections, links, clients, types, protocols, sessions, registry }: AppDeps): Hono {
  const api = new Hono();

  const connectionOf = (deviceId: string | undefined, connectionId: string) => {
    const record = deviceOr404(catalog, deviceId);
    const connection = connections.get(connectionId);
    if (!connection || connection.deviceId !== record.id) throw new HTTPException(404, { message: 'No such connection' });
    return { record, connection };
  };

  /** Makes this the way to reach the device, whenever it can be reached. */
  api.post('/devices/:id/connections/:connection/prefer', async (c) => {
    const { record, connection } = connectionOf(c.req.param('id'), c.req.param('connection'));
    connections.prefer(connection.id);
    auditAbout(c, 'device.connection-preferred', 'device', record.id, `"${record.name}" is now reached by ${connection.method} first`);
    await sessions.sync(catalog.list());
    return c.json(registry.find(record.id));
  });

  /** Removes one way to reach a device. Not the last: that is removing the device. */
  api.delete('/devices/:id/connections/:connection', async (c) => {
    const { record, connection } = connectionOf(c.req.param('id'), c.req.param('connection'));
    if (connections.forDevice(record.id).length <= 1) {
      throw new HTTPException(409, { message: 'This is the only way to reach it. Remove the device instead.' });
    }
    connections.remove(connection.id);
    auditAbout(c, 'device.connection-removed', 'device', record.id, `"${record.name}" is no longer reached by ${connection.method} (${connection.address})`);
    await sessions.sync(catalog.list());
    return c.json(registry.find(record.id));
  });

  /**
   * Replaces a server-held connection's secrets: a plug's local key can
   * change every time it is paired again. Write-only, like every secret.
   */
  api.put('/devices/:id/connections/:connection/secrets', async (c) => {
    const { record, connection } = connectionOf(c.req.param('id'), c.req.param('connection'));
    if (connection.heldBy) throw new HTTPException(409, { message: 'That connection’s secrets are kept by the app that holds it' });
    const method = sessions.typeOf(record)?.connections.find((candidate) => candidate.id === connection.method) ?? null;
    const schema = connectionSchema(method, method ? protocols.get(method.protocol) : null);

    const given = await body(c, z.record(z.string().max(64), z.string().min(1).max(4096)));
    const refused = Object.keys(given).filter((field) => !schema.fields[field] || !isSecretField(schema.fields[field]!));
    if (refused.length) throw new HTTPException(400, { message: `Not a secret of this connection: ${refused.join(', ')}` });

    connections.setSecrets(connection.id, given);
    // Which fields, never their values.
    auditAbout(c, 'device.secrets-changed', 'device', record.id, `Changed ${Object.keys(given).join(', ')} for "${record.name}"`);
    // Reopened, so the new key is used now rather than at the next restart.
    await sessions.close(record.id);
    await sessions.sync(catalog.list());
    return c.json(registry.find(record.id));
  });

  // --- links ------------------------------------------------------------------

  /** "Garage station — Mains", or a device's name for its main part: how a link's ends read on the timeline. */
  const endName = (end: { device: string; part: string }): string => {
    const record = catalog.get(savedDeviceId(end.device));
    if (!record) return 'a removed device';
    if (end.part === MAIN_PART) return record.name;
    const part = partsOf(record.removedAt ? record.description : sessions.description(record)).find((candidate) => candidate.id === end.part);
    return `${record.name} — ${part?.label ?? end.part}`;
  };

  const LINK_END = z.object({ device: z.string().min(1).max(80), part: z.string().min(1).max(80) }).strict();

  /** Records a fact about the house, between two parts: this plug's relay feeds that station's mains input. */
  api.post('/links', async (c) => {
    const input = await body(c, z.object({ kind: z.string().min(1).max(40), source: LINK_END, target: LINK_END }).strict());
    if (!isLinkKind(input.kind)) throw new HTTPException(400, { message: `There is no link called "${input.kind}"` });
    const source = deviceOr404(catalog, input.source.device);
    const target = deviceOr404(catalog, input.target.device);
    if (source.id === target.id) throw new HTTPException(400, { message: 'A device cannot be linked to itself' });
    const kind = linkKindSpec(input.kind);
    if (!linkFits(input.kind, sessions.description(source), input.source.part, sessions.description(target), input.target.part)) {
      throw new HTTPException(400, {
        message: `"${endName(input.source)}" cannot be said to ${kind.verb.replace(/s$/, '')} "${endName(input.target)}": the one must offer ${kind.from}, the other ${kind.to}`,
      });
    }
    const link = links.add({ kind: input.kind, source: { device: source.id, part: input.source.part }, target: { device: target.id, part: input.target.part } });
    auditAbout(c, 'device.linked', 'device', source.id, `"${endName(link.source)}" ${kind.verb} "${endName(link.target)}"`, { kind: link.kind, source: link.source, target: link.target });
    return c.json(link);
  });

  api.delete('/links/:id', (c) => {
    const link = links.get(c.req.param('id'));
    if (!link) throw new HTTPException(404, { message: 'No such link' });
    links.remove(link.id);
    auditAbout(c, 'device.unlinked', 'device', link.source.device, `"${endName(link.source)}" no longer ${linkKindSpec(link.kind).verb} "${endName(link.target)}"`);
    return c.json({ ok: true });
  });

  // --- clients ----------------------------------------------------------------

  /**
   * A phone or browser says who it is and what it can reach devices over. It
   * does so at every start, so "held by Olof's iPhone" has something to name
   * and the add flow knows what this app can hold.
   */
  api.post('/clients', async (c) => {
    const user = userOf(c);
    if (!user) throw new HTTPException(401, { message: 'Sign in first' });
    const input = await body(
      c,
      z
        .object({
          id: z.string().min(1).max(40).optional(),
          name: z.string().trim().min(1).max(60),
          platform: z.enum(['web', 'native']),
          transports: z.array(z.string().min(1).max(20)).max(10),
        })
        .strict()
    );
    return c.json(clients.register({ ...input, userId: user.id }));
  });

  api.get('/clients', (c) => {
    const user = userOf(c);
    if (!user) throw new HTTPException(401, { message: 'Sign in first' });
    return c.json({ clients: clients.forUser(user.id) });
  });

  /** Forgets a phone or browser, and every connection it held. */
  api.delete('/clients/:id', async (c) => {
    const user = userOf(c);
    const client = clients.get(c.req.param('id'));
    if (!user || !client || client.userId !== user.id) throw new HTTPException(404, { message: 'No such app' });
    clients.remove(client.id);
    auditAbout(c, 'client.forgotten', 'client', client.id, `Forgot "${client.name}" and every connection it held`);
    await sessions.sync(catalog.list());
    return c.json({ ok: true });
  });

  return api;
}
