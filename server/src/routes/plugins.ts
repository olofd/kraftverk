import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';

import { isActuator, validateConfig as validatePluginConfig } from '@kraftverk/device-sdk';

import { CONFIRMATION_PHRASE } from '../actions/gateway.ts';
import { actorOf } from '../auth/routes.ts';
import { secretsAreEncrypted } from '../history/db.ts';
import { withTimeout, type PluginInstance } from '../plugins/host.ts';
import { body, type AppDeps } from './shared.ts';

/**
 * Extensions.
 *
 * Plugins provide signals and offer capabilities; they never actuate. Every
 * relay command goes through the action gateway, which checks the grant, the
 * policy and the freshness of the data, then proves the physical effect
 * happened. See docs/PLUGIN-ARCHITECTURE.md.
 */
export function pluginRoutes({ host }: AppDeps): Hono {
  const plugins = new Hono();

  const describePlugin = (instance: PluginInstance) => {
    const health = host.health(instance.manifest.id);
    return {
      id: instance.manifest.id,
      name: instance.manifest.name,
      description: instance.manifest.description,
      version: instance.manifest.version,
      kind: instance.manifest.kind,
      icon: instance.manifest.ui.icon,
      capabilities: instance.manifest.capabilities,
      setupActions: instance.manifest.setupActions ?? [],
      /*
        Lifecycle and liveness are different questions — a plugin can have
        started cleanly and still be unable to reach its device. Report the
        liveness one, because "healthy" beside a failed health check is exactly
        the green light over stale data the brief warns about.
      */
      status: instance.status === 'healthy' ? health.status : instance.status,
      enabled: host.enabled(instance.manifest.id),
      health,
      grants: host.grants(instance.manifest.id),
      error: instance.error ?? health.detail ?? null,
    };
  };

  const instanceOr404 = (id: string) => {
    const instance = host.instance(id);
    if (!instance) throw new HTTPException(404, { message: 'No such plugin' });
    return instance;
  };

  plugins.get('/', (c) =>
    c.json({
      secretsEncrypted: secretsAreEncrypted(),
      activeProviders: { gridRelay: host.activeProvider('gridRelay') },
      plugins: host.all.map(describePlugin),
    })
  );

  plugins.get('/:id/config', (c) => {
    const instance = instanceOr404(c.req.param('id'));
    return c.json({
      id: instance.manifest.id,
      schema: instance.manifest.configSchema,
      // Secrets are never returned — only whether each one has been set.
      values: host.configOf(instance.manifest.id),
      secretsSet: host.secretsSet(instance.manifest.id),
      enabled: host.enabled(instance.manifest.id),
    });
  });

  plugins.patch('/:id/config', async (c) => {
    const id = instanceOr404(c.req.param('id')).manifest.id;
    await host.setConfig(id, await body(c, z.record(z.string(), z.unknown())), actorOf(c));
    if (host.enabled(id)) await host.restart(id);
    return c.json({ ok: true, status: host.instance(id)?.status, health: host.health(id) });
  });

  plugins.post('/:id/enable', async (c) => {
    const id = instanceOr404(c.req.param('id')).manifest.id;
    const { enabled } = await body(c, z.object({ enabled: z.boolean() }));
    await host.setEnabled(id, enabled, actorOf(c));
    return c.json({ ok: true, status: host.instance(id)?.status, health: host.health(id) });
  });

  /** Side-effect-free probe. For the Tuya plugin this dumps every datapoint. */
  plugins.post('/:id/test', async (c) => {
    const instance = instanceOr404(c.req.param('id'));
    if (!instance.plugin.test) return c.json({ ok: false, detail: 'This plugin offers no test' });
    return c.json(await instance.plugin.test());
  });

  /**
   * Runs a commissioning helper the plugin declared in its manifest.
   *
   * Generic on purpose: this route knows nothing about Tuya, or about what the
   * action does. It validates the input against the schema the plugin
   * published, runs it with a timeout, and hands back the result. Runs on a
   * stopped plugin: getting to a working configuration is the point.
   *
   * What comes back is stored, not returned, when the plugin marks it as a
   * secret: see `PluginHost.runSetupAction`.
   */
  plugins.post('/:id/setup/:action', async (c) => {
    const instance = instanceOr404(c.req.param('id'));
    const actionId = c.req.param('action');
    const action = instance.manifest.setupActions?.find((candidate) => candidate.id === actionId);
    if (!action || !instance.plugin.runSetupAction) {
      throw new HTTPException(404, { message: `No setup action "${actionId}"` });
    }

    const input = await body(c, z.record(z.string(), z.unknown()));
    if (action.input) {
      const validated = validatePluginConfig(action.input, input);
      if (!validated.ok) return c.json({ ok: false, detail: validated.issues.map((i) => i.message).join('; ') }, 400);
    }

    // A network scan legitimately takes tens of seconds; a hung cloud call must
    // not take the route with it.
    const result = await withTimeout(
      host.runSetupAction(instance.manifest.id, actionId, input as Record<string, string | number | boolean>, actorOf(c)),
      'The setup action',
      90_000
    ).catch((error: unknown) => ({ ok: false, detail: error instanceof Error ? error.message : String(error) }));

    return c.json(result);
  });

  plugins.post('/:id/grants', async (c) => {
    const instance = instanceOr404(c.req.param('id'));
    const id = instance.manifest.id;
    const { capability, granted, confirmation } = await body(
      c,
      z.object({ capability: z.string(), granted: z.boolean(), confirmation: z.string().optional() })
    );

    const name = capability as (typeof instance.manifest.capabilities)[number];
    if (!instance.manifest.capabilities.includes(name)) {
      throw new HTTPException(400, { message: `${id} does not offer ${capability}` });
    }
    // Granting something that can move a physical switch is a two-step act.
    if (granted && isActuator(name) && confirmation !== CONFIRMATION_PHRASE) {
      throw new HTTPException(400, { message: `Granting ${capability} controls mains power and needs confirmation` });
    }

    host.setGrant(id, name, granted, actorOf(c));
    return c.json({ ok: true, grants: host.grants(id) });
  });

  plugins.post('/:id/provider', (c) => {
    const id = instanceOr404(c.req.param('id')).manifest.id;
    host.setActiveProvider('gridRelay', id, actorOf(c));
    return c.json({ ok: true, activeProvider: host.activeProvider('gridRelay') });
  });

  return plugins;
}
