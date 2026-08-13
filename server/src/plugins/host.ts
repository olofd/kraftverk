import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  isActuator,
  isCompatible,
  validateConfig,
  secretFields,
  withoutSecrets,
  type CapabilityImpl,
  type CapabilityName,
  type ConfigValues,
  type KraftverkPlugin,
  type PluginContext,
  type PluginHealth,
  type PluginManifest,
  type PluginStatus,
  type Resource,
} from '@kraftverk/plugin-sdk';

import { audit, db, openSecret, sealSecret } from '../history/db.ts';

/**
 * The plugin host: discovery, lifecycle, configuration and the capability
 * registry.
 *
 * The contract it enforces is simple to state and load-bearing: a plugin gets a
 * scoped context and nothing else, every call into it is wrapped, and a plugin
 * that misbehaves is disabled rather than allowed to take the station down with
 * it. Actuation is not here at all — that belongs to the action gateway, which
 * is the only caller allowed to reach a `gridRelay.switch` implementation.
 */

const PLUGIN_ROOT = resolve(import.meta.dirname, '../../../packages/plugins');
const CALL_TIMEOUT_MS = 10_000;

export type PluginInstance = {
  manifest: PluginManifest;
  plugin: KraftverkPlugin;
  status: PluginStatus;
  error: string | null;
  capabilities: Map<CapabilityName, unknown>;
  timers: ReturnType<typeof setInterval>[];
  /** Non-secret, validated, defaults applied. */
  config: ConfigValues;
};

const withTimeout = async <T>(work: Promise<T>, what: string): Promise<T> =>
  Promise.race([
    work,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${what} did not finish in ${CALL_TIMEOUT_MS}ms`)), CALL_TIMEOUT_MS)
    ),
  ]);

export class PluginHost {
  #instances = new Map<string, PluginInstance>();

  get all(): PluginInstance[] {
    return [...this.#instances.values()];
  }

  instance(id: string): PluginInstance | undefined {
    return this.#instances.get(id);
  }

  /**
   * Finds and constructs every plugin in `packages/plugins`.
   *
   * A package opts in by declaring `kraftverk.plugin` in its package.json. A
   * plugin that fails to load, or was built against another API version, is
   * skipped with a logged reason — never fatal, because the station has to keep
   * working when an extension does not.
   */
  async discover(): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(PLUGIN_ROOT);
    } catch {
      return; // no plugins directory: a perfectly valid installation
    }

    for (const entry of entries) {
      const packageFile = resolve(PLUGIN_ROOT, entry, 'package.json');
      try {
        const meta = JSON.parse(await readFile(packageFile, 'utf8')) as {
          kraftverk?: { plugin?: string };
        };
        const relative = meta.kraftverk?.plugin;
        if (!relative) continue;

        const module = (await import(pathToFileURL(resolve(PLUGIN_ROOT, entry, relative)).href)) as {
          default?: () => KraftverkPlugin;
        };
        const plugin = module.default?.();
        if (!plugin) throw new Error('the package has no default export returning a plugin');

        const { manifest } = plugin;
        if (!isCompatible(manifest.apiVersion)) {
          console.warn(
            `[plugins] ${manifest.id} targets API ${manifest.apiVersion}; this server speaks 1. Disabled.`
          );
          continue;
        }

        this.#instances.set(manifest.id, {
          manifest,
          plugin,
          status: 'installed',
          error: null,
          capabilities: new Map(),
          timers: [],
          config: {},
        });
      } catch (error) {
        console.warn(`[plugins] could not load ${entry}:`, (error as Error).message);
      }
    }
  }

  /** Starts every plugin the user has enabled and configured. */
  async startEnabled(): Promise<void> {
    for (const instance of this.#instances.values()) {
      const row = this.#configRow(instance.manifest.id);
      if (!row?.enabled) {
        instance.status = row ? 'disabled' : 'installed';
        continue;
      }
      await this.start(instance.manifest.id);
    }
  }

  async start(id: string): Promise<void> {
    const instance = this.#instances.get(id);
    if (!instance) throw new Error(`No plugin ${id}`);
    if (instance.status === 'starting' || instance.status === 'healthy') return;

    /*
      Secrets live in their own table and never in the config JSON, so the
      stored config alone would fail a schema that requires one. Validate with a
      placeholder for every secret that has been set — the plugin reads the real
      value through `context.secrets`, and the placeholder is stripped again
      before the config reaches it.
    */
    const stored = this.#storedConfig(id);
    const present = new Set(this.secretsSet(id));
    const forValidation = { ...stored };
    for (const field of secretFields(instance.manifest.configSchema)) {
      if (present.has(field)) forValidation[field] = 'stored';
    }

    const validated = instance.plugin.validateConfig(forValidation);
    if (!validated.ok) {
      instance.status = 'needs-configuration';
      instance.error = validated.issues.map((issue) => `${issue.field}: ${issue.message}`).join('; ');
      return;
    }

    instance.config = withoutSecrets(instance.manifest.configSchema, validated.value);
    instance.status = 'starting';
    instance.error = null;
    instance.capabilities.clear();

    try {
      await withTimeout(instance.plugin.start(this.#contextFor(instance)), `${id} start`);
      instance.status = 'healthy';
      audit({ at: new Date().toISOString(), kind: 'plugin.started', actor: 'system', summary: `${id} started` });
    } catch (error) {
      instance.status = 'failed';
      instance.error = error instanceof Error ? error.message : String(error);
      this.#clearTimers(instance);
      audit({
        at: new Date().toISOString(),
        kind: 'plugin.failed',
        actor: 'system',
        summary: `${id} failed to start`,
        detail: instance.error,
      });
    }
  }

  async stop(id: string): Promise<void> {
    const instance = this.#instances.get(id);
    if (!instance) return;

    this.#clearTimers(instance);
    try {
      await withTimeout(instance.plugin.stop(), `${id} stop`);
    } catch (error) {
      console.warn(`[plugins] ${id} did not stop cleanly:`, (error as Error).message);
    }
    instance.capabilities.clear();
    instance.status = this.#configRow(id)?.enabled ? 'installed' : 'disabled';
  }

  async restart(id: string): Promise<void> {
    await this.stop(id);
    await this.start(id);
  }

  /** Health, with failures reported rather than thrown. */
  health(id: string): PluginHealth {
    const instance = this.#instances.get(id);
    if (!instance) return { status: 'failed', detail: 'unknown plugin' };
    if (instance.status === 'failed') return { status: 'failed', detail: instance.error ?? undefined };
    if (instance.status === 'needs-configuration') {
      return { status: 'needs-configuration', detail: instance.error ?? undefined };
    }
    if (instance.status !== 'healthy') return { status: 'starting' };

    try {
      return instance.plugin.health();
    } catch (error) {
      return { status: 'degraded', detail: (error as Error).message };
    }
  }

  // --- configuration -------------------------------------------------------

  #configRow(id: string): { json: string; enabled: number } | null {
    return (
      db()
        .query<{ json: string; enabled: number }, [string]>(
          'SELECT json, enabled FROM plugin_config WHERE plugin_id = ?'
        )
        .get(id) ?? null
    );
  }

  #storedConfig(id: string): ConfigValues {
    const row = this.#configRow(id);
    return row ? (JSON.parse(row.json) as ConfigValues) : {};
  }

  configOf(id: string): ConfigValues {
    return this.#storedConfig(id);
  }

  enabled(id: string): boolean {
    return Boolean(this.#configRow(id)?.enabled);
  }

  /** Which secret fields have a value, without revealing any of them. */
  secretsSet(id: string): string[] {
    return db()
      .query<{ field: string }, [string]>('SELECT field FROM plugin_secret WHERE plugin_id = ?')
      .all(id)
      .map((row) => row.field);
  }

  /**
   * Persists configuration. Secrets are split off into their own table and are
   * never written into the config JSON, so an export or a log cannot leak them.
   */
  async setConfig(id: string, values: Record<string, unknown>): Promise<void> {
    const instance = this.#instances.get(id);
    if (!instance) throw new Error(`No plugin ${id}`);

    const schema = instance.manifest.configSchema;
    const secrets = secretFields(schema);
    const merged = { ...this.#storedConfig(id), ...values };

    // Validate the whole thing, secrets included, before storing any of it.
    const validated = validateConfig(schema, {
      ...merged,
      ...Object.fromEntries(secrets.map((field) => [field, values[field] ?? (this.secretsSet(id).includes(field) ? 'kept' : undefined)])),
    });
    if (!validated.ok) {
      throw new ConfigError(validated.issues);
    }

    const now = new Date().toISOString();
    for (const field of secrets) {
      const value = values[field];
      if (typeof value !== 'string' || value.length === 0) continue;
      const sealed = sealSecret(value);
      db()
        .query(
          'INSERT INTO plugin_secret (plugin_id, field, value, encrypted) VALUES (?, ?, ?, ?) ' +
            'ON CONFLICT (plugin_id, field) DO UPDATE SET value = excluded.value, encrypted = excluded.encrypted'
        )
        .run(id, field, sealed.value, sealed.encrypted ? 1 : 0);
    }

    const json = JSON.stringify(withoutSecrets(schema, validated.value));
    db()
      .query(
        'INSERT INTO plugin_config (plugin_id, json, enabled, updated_at) VALUES (?, ?, COALESCE((SELECT enabled FROM plugin_config WHERE plugin_id = ?), 0), ?) ' +
          'ON CONFLICT (plugin_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at'
      )
      .run(id, json, id, now);

    audit({ at: now, kind: 'plugin.configured', actor: 'user', summary: `${id} configuration changed` });
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const now = new Date().toISOString();
    db()
      .query(
        'INSERT INTO plugin_config (plugin_id, json, enabled, updated_at) VALUES (?, COALESCE((SELECT json FROM plugin_config WHERE plugin_id = ?), \'{}\'), ?, ?) ' +
          'ON CONFLICT (plugin_id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at'
      )
      .run(id, id, enabled ? 1 : 0, now);

    audit({ at: now, kind: enabled ? 'plugin.enabled' : 'plugin.disabled', actor: 'user', summary: id });
    if (enabled) await this.start(id);
    else await this.stop(id);
  }

  // --- capabilities and grants --------------------------------------------

  isGranted(id: string, capability: CapabilityName): boolean {
    return Boolean(
      db()
        .query<{ plugin_id: string }, [string, string]>(
          'SELECT plugin_id FROM capability_grant WHERE plugin_id = ? AND capability = ?'
        )
        .get(id, capability)
    );
  }

  grants(id: string): CapabilityName[] {
    return db()
      .query<{ capability: string }, [string]>('SELECT capability FROM capability_grant WHERE plugin_id = ?')
      .all(id)
      .map((row) => row.capability as CapabilityName);
  }

  setGrant(id: string, capability: CapabilityName, granted: boolean): void {
    const now = new Date().toISOString();
    if (granted) {
      db()
        .query('INSERT OR IGNORE INTO capability_grant (plugin_id, capability, granted_at) VALUES (?, ?, ?)')
        .run(id, capability, now);
    } else {
      db().query('DELETE FROM capability_grant WHERE plugin_id = ? AND capability = ?').run(id, capability);
    }

    audit({
      at: now,
      kind: granted ? 'grant.given' : 'grant.revoked',
      actor: 'user',
      summary: `${capability} ${granted ? 'granted to' : 'revoked from'} ${id}`,
      detail: { actuator: isActuator(capability) },
    });
  }

  activeProvider(resource: Resource): string | null {
    const row = db()
      .query<{ plugin_id: string }, [string]>('SELECT plugin_id FROM active_provider WHERE resource = ?')
      .get(resource);
    if (row) return row.plugin_id;

    // Nothing chosen yet: adopt the only healthy candidate, if there is exactly
    // one. Two candidates is a question for the user, not a coin toss.
    const candidates = this.all.filter(
      (instance) => instance.status === 'healthy' && instance.capabilities.has('gridRelay.switch')
    );
    return candidates.length === 1 ? candidates[0]!.manifest.id : null;
  }

  setActiveProvider(resource: Resource, id: string): void {
    const now = new Date().toISOString();
    db()
      .query(
        'INSERT INTO active_provider (resource, plugin_id, chosen_at) VALUES (?, ?, ?) ' +
          'ON CONFLICT (resource) DO UPDATE SET plugin_id = excluded.plugin_id, chosen_at = excluded.chosen_at'
      )
      .run(resource, id, now);
    audit({ at: now, kind: 'provider.chosen', actor: 'user', resource, summary: `${id} now owns ${resource}` });
  }

  /** The implementation registered for a capability, if the plugin is running. */
  capability<N extends CapabilityName>(id: string, name: N): CapabilityImpl[N] | null {
    const instance = this.#instances.get(id);
    if (!instance || instance.status !== 'healthy') return null;
    return (instance.capabilities.get(name) as CapabilityImpl[N] | undefined) ?? null;
  }

  // --- the scoped context --------------------------------------------------

  #contextFor(instance: PluginInstance): PluginContext {
    const id = instance.manifest.id;
    const allowed = new Set(instance.manifest.capabilities);

    return {
      log: {
        info: (message, extra) => console.log(`[${id}] ${message}`, extra ?? ''),
        warn: (message, extra) => console.warn(`[${id}] ${message}`, extra ?? ''),
        error: (message, extra) => console.error(`[${id}] ${message}`, extra ?? ''),
      },
      config: instance.config,
      secrets: {
        get: (field) => {
          const row = db()
            .query<{ value: string; encrypted: number }, [string, string]>(
              'SELECT value, encrypted FROM plugin_secret WHERE plugin_id = ? AND field = ?'
            )
            .get(id, field);
          return row ? openSecret(row.value, row.encrypted === 1) : null;
        },
      },
      store: {
        get: <T>(key: string) => {
          const row = db()
            .query<{ value: string }, [string, string]>(
              'SELECT value FROM plugin_kv WHERE plugin_id = ? AND key = ?'
            )
            .get(id, key);
          return row ? (JSON.parse(row.value) as T) : null;
        },
        set: (key, value) => {
          db()
            .query(
              'INSERT INTO plugin_kv (plugin_id, key, value) VALUES (?, ?, ?) ' +
                'ON CONFLICT (plugin_id, key) DO UPDATE SET value = excluded.value'
            )
            .run(id, key, JSON.stringify(value));
        },
        delete: (key) => {
          db().query('DELETE FROM plugin_kv WHERE plugin_id = ? AND key = ?').run(id, key);
        },
        all: () =>
          Object.fromEntries(
            db()
              .query<{ key: string; value: string }, [string]>(
                'SELECT key, value FROM plugin_kv WHERE plugin_id = ?'
              )
              .all(id)
              .map((row) => [row.key, JSON.parse(row.value) as unknown])
          ),
      },
      schedule: (everyMs, task) => {
        let running = false;
        const timer = setInterval(() => {
          // Skip rather than queue: a plug that stops answering must not build
          // a backlog of polls that all fire when it returns.
          if (running) return;
          running = true;
          void Promise.resolve(task())
            .catch((error) => console.warn(`[${id}] scheduled task failed:`, (error as Error).message))
            .finally(() => {
              running = false;
            });
        }, everyMs);
        instance.timers.push(timer);
      },
      http: async (url, init) => {
        const target = new URL(url);
        const hosts = instance.manifest.allowedHosts ?? [];
        if (!hosts.includes(target.hostname)) {
          throw new Error(`${id} may not reach ${target.hostname}; declare it in allowedHosts`);
        }
        const { timeoutMs = 10_000, ...rest } = init ?? {};
        return fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
      },
      emit: (event) => {
        audit({
          at: new Date().toISOString(),
          kind: `plugin.${event.level}`,
          actor: id,
          summary: event.message,
          detail: event.data,
        });
      },
      registerCapability: (name, implementation) => {
        if (!allowed.has(name)) {
          throw new Error(`${id} registered ${name} without declaring it in its manifest`);
        }
        instance.capabilities.set(name, implementation);
      },
    };
  }

  #clearTimers(instance: PluginInstance): void {
    for (const timer of instance.timers) clearInterval(timer);
    instance.timers = [];
  }

  async stopAll(): Promise<void> {
    for (const id of this.#instances.keys()) await this.stop(id);
  }
}

export class ConfigError extends Error {
  constructor(readonly issues: { field: string; message: string }[]) {
    super(issues.map((issue) => `${issue.field}: ${issue.message}`).join('; '));
  }
}
