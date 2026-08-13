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

/**
 * A grid relay that only exists in memory.
 *
 * Two jobs. It makes the reserve feature demonstrable next to the station
 * simulator with no hardware at all, and it gives the action gateway and the
 * controller something to be tested against — including the failure modes that
 * matter and are impossible to stage on a real plug on demand:
 *
 *   unreachable          the plug has dropped off the network
 *   ignore-commands      commands are accepted but the relay never moves
 *   slow                 answers arrive, eventually
 *
 * A gateway that cannot tell "accepted" from "actually switched" will pass its
 * tests against a well-behaved fake and fail in the field. This one misbehaves
 * on purpose.
 */

export type FakeFault = 'none' | 'unreachable' | 'ignore-commands' | 'slow';

const configSchema: ConfigSchema = {
  help: 'A pretend plug for development. It switches nothing in the real world.',
  fields: {
    startOn: { type: 'boolean', title: 'Relay starts on', default: true },
    watts: { type: 'number', title: 'Load through the plug', default: 240, min: 0, max: 3600, unit: 'W' },
    volts: { type: 'number', title: 'Line voltage', default: 230, min: 0, max: 265, unit: 'V' },
    fault: {
      type: 'enum',
      title: 'Simulated fault',
      default: 'none',
      options: [
        { value: 'none', label: 'Behaving' },
        { value: 'unreachable', label: 'Unreachable' },
        { value: 'ignore-commands', label: 'Accepts commands, never switches' },
        { value: 'slow', label: 'Slow to answer' },
      ],
    },
    bootBehaviour: {
      type: 'enum',
      title: 'After a power cut the relay comes back',
      default: 'last',
      options: [
        { value: 'unknown', label: 'Not tested yet' },
        { value: 'on', label: 'On' },
        { value: 'off', label: 'Off' },
        { value: 'last', label: 'Last state' },
      ],
    },
  },
};

const manifest: PluginManifest = {
  id: 'dev.kraftverk.fake-grid-relay',
  name: 'Simulated smart plug',
  description: 'An in-memory grid relay for development and tests. Switches nothing real.',
  version: '0.1.0',
  apiVersion: '1',
  kind: 'grid-relay',
  capabilities: ['powerMeter.read', 'gridRelay.read', 'gridRelay.switch'],
  configSchema,
  ui: { icon: 'cpu' },
};

class FakeGridRelay implements KraftverkPlugin, GridRelayProvider {
  readonly manifest = manifest;

  #context: PluginContext | null = null;
  #relayOn = true;
  #kwh = 0;
  #lastRead = new Date();

  validateConfig(config: unknown) {
    return validateConfig(configSchema, config);
  }

  get bootBehaviour(): BootBehaviour {
    return (this.#context?.config.bootBehaviour as BootBehaviour | undefined) ?? 'last';
  }

  get #fault(): FakeFault {
    return (this.#context?.config.fault as FakeFault | undefined) ?? 'none';
  }

  async start(context: PluginContext): Promise<void> {
    this.#context = context;
    this.#relayOn = context.config.startOn !== false;

    context.registerCapability('powerMeter.read', this);
    context.registerCapability('gridRelay.read', this);
    context.registerCapability('gridRelay.switch', this);

    // Accumulate energy so history and charts have something to show.
    context.schedule(60_000, () => {
      if (this.#relayOn) this.#kwh += Number(context.config.watts ?? 0) / 60_000;
    });
  }

  async stop(): Promise<void> {
    this.#context = null;
  }

  devices() {
    return [
      {
        id: 'fake:plug',
        name: 'Simulated plug',
        kind: 'smart-plug' as const,
        icon: 'cpu',
        description: 'Switches nothing real',
        measurements: [
          { key: 'watts', label: 'Power', unit: 'W', kind: 'power' as const, precision: 0, primary: true },
          { key: 'volts', label: 'Voltage', unit: 'V', kind: 'voltage' as const, precision: 1 },
          { key: 'amps', label: 'Current', unit: 'A', kind: 'current' as const, precision: 2 },
          { key: 'kwh', label: 'Energy', unit: 'kWh', kind: 'energy' as const, precision: 3, cumulative: true },
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
            consequence: 'Pretends to cut mains to the station. Nothing physical happens.',
          },
        ],
      },
    ];
  }

  async readDevice() {
    const state = await this.getState();
    const at = state.updatedAt;
    return [
      { key: 'watts', value: state.watts ?? null, at },
      { key: 'volts', value: state.volts ?? null, at },
      { key: 'amps', value: state.amps ?? null, at },
      { key: 'kwh', value: state.kwh ?? null, at },
      { key: 'relay', value: state.relayOn, at },
    ];
  }

  async read() {
    return this.getState();
  }

  async getState(): Promise<RelayState> {
    if (this.#fault === 'unreachable') {
      return { relayOn: this.#relayOn, reachable: false, updatedAt: this.#lastRead.toISOString() };
    }
    if (this.#fault === 'slow') await new Promise((resolve) => setTimeout(resolve, 3_000));

    this.#lastRead = new Date();
    const volts = Number(this.#context?.config.volts ?? 230);
    const watts = this.#relayOn ? Number(this.#context?.config.watts ?? 0) : 0;

    return {
      relayOn: this.#relayOn,
      reachable: true,
      volts,
      watts,
      amps: volts > 0 ? Math.round((watts / volts) * 100) / 100 : 0,
      kwh: Math.round(this.#kwh * 1000) / 1000,
      hz: 50,
      updatedAt: this.#lastRead.toISOString(),
    };
  }

  async setRelay(on: boolean, reason: string): Promise<CommandResult> {
    const started = Date.now();
    this.#context?.emit({ level: 'info', message: `Relay ${on ? 'on' : 'off'}`, data: { reason } });

    if (this.#fault === 'unreachable') {
      return { accepted: false, error: 'Simulated: plug unreachable', tookMs: Date.now() - started };
    }
    if (this.#fault === 'slow') await new Promise((resolve) => setTimeout(resolve, 3_000));

    // The nastiest failure to design against: the command succeeds and nothing
    // physically happens.
    if (this.#fault !== 'ignore-commands') this.#relayOn = on;

    return { accepted: true, readback: await this.getState(), tookMs: Date.now() - started };
  }

  health(): PluginHealth {
    if (this.#fault === 'unreachable') {
      return { status: 'degraded', detail: 'Simulated: plug unreachable' };
    }
    return { status: 'healthy', lastOk: this.#lastRead.toISOString(), dataAgeMs: 0 };
  }

  async test() {
    const state = await this.getState();
    return {
      ok: state.reachable,
      detail: state.reachable ? `Simulated plug is ${state.relayOn ? 'on' : 'off'}` : 'Simulated: unreachable',
      data: { state },
    };
  }
}

export default function createPlugin(): KraftverkPlugin {
  return new FakeGridRelay();
}
