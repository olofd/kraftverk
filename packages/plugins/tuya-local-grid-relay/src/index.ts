import {
  validateConfig,
  type BootBehaviour,
  type CommandResult,
  type ConfigSchema,
  type GridRelayProvider,
  type KraftverkPlugin,
  type PluginContext,
  type PluginHealth,
  type PluginManifest,
  type RelayState,
} from '@kraftverk/plugin-sdk';

import { decode, PROFILES, profileById, relayCandidates } from './profiles.ts';
import { runSetupAction, SETUP_ACTIONS } from './setup.ts';
import { TuyaSession, type Dps } from './session.ts';
import type { ProtocolVersion } from './frame.ts';

/**
 * A grid relay reached directly over the Tuya LAN protocol.
 *
 * Built for an ATORCH S1W upstream of the P280's AC input, but nothing here is
 * ATORCH-specific: the model knowledge is in `profiles.ts`, so another Tuya
 * socket is a profile rather than a plugin.
 *
 * The plugin only ever *offers* the switch capability. Whether a command is
 * allowed — grants, dwell, freshness, reserve rules — is decided by the core's
 * action gateway, which is also the only thing that calls it.
 */

const configSchema: ConfigSchema = {
  help:
    'Use “Find it” above to fill the address and device id from the network, and to fetch the ' +
    'local key. The key is the only part that needs a Tuya cloud account, once — see ' +
    'docs/TUYA-LOCAL-KEY.md.',
  fields: {
    host: {
      type: 'host',
      title: 'Address',
      description: 'The plug\'s IP on your LAN. Give it a DHCP reservation so it cannot move.',
      required: true,
    },
    deviceId: {
      type: 'string',
      title: 'Device id',
      description: 'From the scan, or the "Virtual ID" in the Smart Life app.',
      required: true,
    },
    localKey: {
      type: 'secret',
      title: 'Local key',
      description: '16 characters. Never leaves the server.',
      required: true,
    },
    protocolVersion: {
      type: 'enum',
      title: 'Protocol',
      description:
        'Leave on Detect unless you have a reason not to: a wrong choice looks exactly like a ' +
        'wrong key. Detect tries each until the plug answers, and Test reports which one won.',
      default: 'auto',
      options: [
        { value: 'auto', label: 'Detect' },
        { value: '3.3', label: '3.3' },
        { value: '3.4', label: '3.4' },
        { value: '3.5', label: '3.5' },
      ],
    },
    profile: {
      type: 'enum',
      title: 'Device profile',
      description: 'Which datapoint map to use.',
      default: 'atorch-s1',
      options: PROFILES.map((profile) => ({ value: profile.id, label: profile.label })),
    },
    relayDp: {
      type: 'number',
      title: 'Relay datapoint',
      description: 'Override when Test shows the relay is not on the profile default.',
      integer: true,
      min: 1,
      max: 255,
    },
    bootBehaviour: {
      type: 'enum',
      title: 'After a power cut the relay comes back',
      description:
        'Establish this with a real power-cut test. Automation will not arm while it is unknown, ' +
        'because a plug that boots OFF can strand a flat station with no way to charge.',
      default: 'unknown',
      options: [
        { value: 'unknown', label: 'Not tested yet' },
        { value: 'on', label: 'On' },
        { value: 'off', label: 'Off' },
        { value: 'last', label: 'Last state' },
      ],
    },
    pollSeconds: {
      type: 'number',
      title: 'Poll interval',
      default: 10,
      min: 2,
      max: 300,
      unit: 's',
      integer: true,
    },
  },
};

const manifest: PluginManifest = {
  id: 'com.tuya-local.grid-relay',
  name: 'Tuya smart plug (local)',
  description:
    'Controls a Tuya socket over your LAN with no vendor cloud. Verified against an ATORCH S1W.',
  version: '0.1.0',
  apiVersion: '1',
  kind: 'grid-relay',
  capabilities: ['powerMeter.read', 'gridRelay.read', 'gridRelay.switch'],
  configSchema,
  setupActions: SETUP_ACTIONS,
  ui: { icon: 'power', setupHelp: configSchema.help },
};

class TuyaGridRelay implements KraftverkPlugin, GridRelayProvider {
  readonly manifest = manifest;

  #context: PluginContext | null = null;
  #session: TuyaSession | null = null;
  #state: RelayState | null = null;
  #lastError: string | null = null;
  #lastOk: string | null = null;

  validateConfig(config: unknown) {
    return validateConfig(configSchema, config);
  }

  /** Commissioning helpers. Deliberately independent of plugin state. */
  runSetupAction(id: string, input: Record<string, string | number | boolean | undefined>) {
    return runSetupAction(id, input);
  }

  get bootBehaviour(): BootBehaviour {
    return (this.#context?.config.bootBehaviour as BootBehaviour | undefined) ?? 'unknown';
  }

  get #profile() {
    return profileById(String(this.#context?.config.profile ?? 'atorch-s1'));
  }

  get #relayDp(): number {
    const override = this.#context?.config.relayDp;
    return typeof override === 'number' ? override : this.#profile.relay.dp;
  }

  async start(context: PluginContext): Promise<void> {
    this.#context = context;

    const localKey = context.secrets.get('localKey');
    if (!localKey) throw new Error('No local key configured');

    this.#session = new TuyaSession({
      host: String(context.config.host),
      deviceId: String(context.config.deviceId),
      localKey,
      version: String(context.config.protocolVersion ?? 'auto') as ProtocolVersion | 'auto',
      log: (message, extra) => context.log.info(message, extra),
    });

    context.registerCapability('powerMeter.read', this);
    context.registerCapability('gridRelay.read', this);
    context.registerCapability('gridRelay.switch', this);

    const pollMs = Number(context.config.pollSeconds ?? 10) * 1000;
    context.schedule(pollMs, () => this.#poll());

    /*
      Deliberately not awaited. Starting must not depend on the plug being
      reachable: protocol detection alone can spend fifteen seconds trying three
      versions, and a plug that is merely asleep would then look like a plugin
      that failed to load. The first poll reports through `health()` instead.
    */
    void this.#poll();
  }

  async stop(): Promise<void> {
    await this.#session?.close();
    this.#session = null;
    this.#state = null;
  }

  async #poll(): Promise<void> {
    try {
      const dps = await this.#session!.status();
      // An empty reply is not a reading. Recording it would refresh the
      // freshness clock with nothing behind it.
      if (Object.keys(dps).length === 0) throw new Error('The plug answered with no datapoints');
      this.#ingest(dps);
      this.#lastError = null;
    } catch (error) {
      this.#lastError = error instanceof Error ? error.message : String(error);
      // Deliberately leaves `#state` alone rather than zeroing it: the gateway
      // decides what to do with a stale reading, and a stale one that is
      // labelled stale is more useful than a fabricated zero.
      if (this.#state) this.#state = { ...this.#state, reachable: false };
    }
  }

  #ingest(dps: Dps): void {
    const reading = decode(this.#profile, dps, this.#relayDp);
    const now = new Date().toISOString();
    this.#lastOk = now;
    this.#state = {
      relayOn: reading.relayOn ?? false,
      reachable: true,
      volts: reading.volts,
      amps: reading.amps,
      watts: reading.watts,
      kwh: reading.kwh,
      hz: reading.hz,
      powerFactor: reading.powerFactor,
      updatedAt: now,
    };
  }

  // --- as a device --------------------------------------------------------

  /**
   * One plug, described so the app can draw it without knowing what Tuya is.
   *
   * The id is namespaced by the device id rather than the plugin, so the same
   * driver could later provide several plugs and each keeps its own history.
   */
  devices() {
    const deviceId = String(this.#context?.config.deviceId ?? 'unconfigured');
    return [
      {
        id: `tuya:${deviceId}`,
        name: 'Tuya smart plug',
        kind: 'smart-plug' as const,
        icon: 'power',
        description: this.#profile.label,
        measurements: [
          { key: 'watts', label: 'Power', unit: 'W', kind: 'power' as const, precision: 0, primary: true },
          { key: 'volts', label: 'Voltage', unit: 'V', kind: 'voltage' as const, precision: 1 },
          { key: 'amps', label: 'Current', unit: 'A', kind: 'current' as const, precision: 2 },
          { key: 'kwh', label: 'Energy', unit: 'kWh', kind: 'energy' as const, precision: 2, cumulative: true },
          { key: 'hz', label: 'Frequency', unit: 'Hz', kind: 'frequency' as const, precision: 1 },
          { key: 'relay', label: 'Relay', unit: '', kind: 'state' as const },
        ],
        controls: [
          {
            id: 'relay',
            label: 'Relay',
            kind: 'switch' as const,
            capability: 'gridRelay.switch' as const,
            measurementKey: 'relay',
            dangerous: true,
            consequence:
              'This plug feeds the station’s AC input. Switching it off makes everything plugged ' +
              'into the station run from its battery and solar.',
          },
        ],
      },
    ];
  }

  async readDevice() {
    const state = this.#state;
    const at = state?.updatedAt ?? new Date(0).toISOString();
    const value = (reading: number | undefined) => (reading === undefined ? null : reading);

    return [
      { key: 'watts', value: value(state?.watts), at },
      { key: 'volts', value: value(state?.volts), at },
      { key: 'amps', value: value(state?.amps), at },
      { key: 'kwh', value: value(state?.kwh), at },
      { key: 'hz', value: value(state?.hz), at },
      { key: 'relay', value: state?.relayOn ?? null, at },
    ];
  }

  async read() {
    return this.getState();
  }

  async getState(): Promise<RelayState> {
    if (!this.#state) {
      return { relayOn: false, reachable: false, updatedAt: new Date(0).toISOString() };
    }
    return this.#state;
  }

  /**
   * Switches the relay. Called only by the core's action gateway.
   *
   * Returns the device's own readback when it offers one — but the gateway does
   * not treat that as proof on its own; it also wants the station's AC input to
   * agree.
   */
  async setRelay(on: boolean, reason: string): Promise<CommandResult> {
    const started = Date.now();
    const context = this.#context;
    context?.emit({ level: 'info', message: `Relay ${on ? 'on' : 'off'} requested`, data: { reason } });

    try {
      const dps = await this.#session!.set({ [String(this.#relayDp)]: on });
      if (Object.keys(dps).length > 0) this.#ingest(dps);
      else await this.#poll();

      return { accepted: true, readback: this.#state ?? undefined, tookMs: Date.now() - started };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#lastError = message;
      context?.emit({ level: 'error', message: `Relay command failed: ${message}` });
      return { accepted: false, error: message, tookMs: Date.now() - started };
    }
  }

  health(): PluginHealth {
    const ageMs = this.#lastOk ? Date.now() - new Date(this.#lastOk).getTime() : undefined;
    const pollMs = Number(this.#context?.config.pollSeconds ?? 10) * 1000;

    if (!this.#lastOk) {
      return { status: this.#lastError ? 'failed' : 'starting', detail: this.#lastError ?? undefined };
    }
    // Two missed polls is a degraded link, not a healthy one with old numbers.
    if (ageMs !== undefined && ageMs > pollMs * 2.5) {
      return {
        status: 'degraded',
        detail: this.#lastError ?? 'The plug has stopped answering',
        lastOk: this.#lastOk,
        dataAgeMs: ageMs,
      };
    }
    return { status: 'healthy', lastOk: this.#lastOk, dataAgeMs: ageMs };
  }

  /**
   * Side-effect-free probe: connect, read everything, switch nothing.
   *
   * This is how a new plug's datapoint map gets established — it reports every
   * raw datapoint, what the current profile makes of them, and which booleans
   * could be the relay.
   */
  async test(): Promise<{ ok: boolean; detail: string; data?: Record<string, unknown> }> {
    if (!this.#session) {
      return { ok: false, detail: 'Not running. Configure the plug and enable it, then test again.' };
    }
    try {
      const dps = await this.#session.status();
      const decoded = decode(this.#profile, dps, this.#relayDp);
      const candidates = relayCandidates(dps);

      return {
        // Nothing decoded is a failure, however cleanly the socket opened.
        ok: Object.keys(dps).length > 0,
        detail:
          `Connected over protocol ${this.#session.version}. ${Object.keys(dps).length} datapoints. ` +
          `Relay reads ${String(decoded.relayOn)} on DP ${this.#relayDp}` +
          (candidates.length > 1 ? `; other boolean datapoints: ${candidates.filter((dp) => dp !== this.#relayDp).join(', ')}` : ''),
        data: {
          protocolVersion: this.#session.version,
          raw: dps,
          decoded,
          relayCandidates: candidates,
          profile: this.#profile.id,
        },
      };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }
}

export default function createPlugin(): KraftverkPlugin {
  return new TuyaGridRelay();
}

export { ATORCH_S1, PROFILES } from './profiles.ts';
export { scan, decodeBroadcast } from './discovery.ts';
