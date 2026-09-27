import { CAPABILITY_NAMES, type CapabilityName } from './capabilities.ts';
import type { DeviceContext, DeviceSession, DeviceType } from './device-type.ts';
import { savedDeviceId } from './identity.ts';
import { validateConfig, type ConfigValues } from './schema.ts';
import type { MetricSpec, Reading } from './telemetry.ts';
import { validateDeviceType } from './validate.ts';

/**
 * The contract suite: what every device type must do, checked against its
 * simulator (docs/ARCHITECTURE.md §8, step 2).
 *
 * `validateDeviceType` checks what a type declares; this checks that its
 * sessions keep those declarations — that the telemetry it reports is the
 * telemetry it declared, that every capability it claims is really there and
 * behaves, and that its settings survive a round trip. A type passes when the
 * returned list is empty:
 *
 *   test('keeps the device-type contract', async () => {
 *     expect(await checkDeviceTypeContract(myType)).toEqual([]);
 *   });
 *
 * Deliberately free of any test framework, so it runs under whichever one a
 * package uses.
 */

export type ContractOptions = {
  /** Config for the simulated device. Defaults from the type's schema otherwise. */
  config?: ConfigValues;
  /** Secrets for it, by config field. */
  secrets?: Record<string, string>;
  /** How long the simulator may take to produce its first readings. */
  settleMs?: number;
};

/** A context with nothing real behind it: memory for storage, no network, no radios. */
export function simulatorContext(
  type: DeviceType<any>,
  options: ContractOptions = {}
): { context: DeviceContext; stop: () => void; events: string[] } {
  const timers: ReturnType<typeof setInterval>[] = [];
  const store = new Map<string, unknown>();
  const events: string[] = [];
  const quiet = () => undefined;

  const validated = validateConfig(type.config, options.config ?? {});
  const config = validated.ok ? validated.value : { ...(options.config ?? {}) };

  const context: DeviceContext = {
    deviceId: savedDeviceId(`contract:${type.id}`),
    config,
    secrets: { get: (field) => options.secrets?.[field] ?? null },
    store: {
      get: <T>(key: string) => (store.has(key) ? (store.get(key) as T) : null),
      set: (key, value) => void store.set(key, value),
      delete: (key) => void store.delete(key),
    },
    log: { info: quiet, warn: quiet, error: quiet },
    http: async (url) => {
      throw new Error(`A simulator may not reach the network (asked for ${url})`);
    },
    transports: { get: () => null },
    readOnly: false,
    schedule: (everyMs, task) => {
      let running = false;
      timers.push(
        setInterval(() => {
          if (running) return;
          running = true;
          void Promise.resolve()
            .then(task)
            .catch(() => undefined)
            .finally(() => {
              running = false;
            });
        }, everyMs)
      );
    },
    emit: (event) => void events.push(`${event.level}: ${event.message}`),
  };

  return { context, events, stop: () => timers.splice(0).forEach(clearInterval) };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls `check` until it is true or the time is up. */
async function eventually(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await sleep(25);
  }
  return check();
}

const isIso = (value: unknown): boolean => typeof value === 'string' && Number.isFinite(Date.parse(value));

function readingProblems(readings: readonly Reading[], telemetry: readonly MetricSpec[]): string[] {
  const problems: string[] = [];
  const declared = new Map(telemetry.map((spec) => [spec.key, spec]));
  const seen = new Set<string>();

  for (const reading of readings) {
    const spec = declared.get(reading.key);
    if (!spec) {
      problems.push(`reports "${reading.key}", which its telemetry does not declare`);
      continue;
    }
    if (seen.has(reading.key)) problems.push(`reports "${reading.key}" twice in one set of readings`);
    seen.add(reading.key);
    if (!isIso(reading.at)) problems.push(`"${reading.key}" has no valid time: ${String(reading.at)}`);
    if (reading.value === null) continue;
    const expected = spec.kind === 'state' ? 'boolean' : 'number';
    if (typeof reading.value !== expected) {
      problems.push(`"${reading.key}" is ${spec.kind}, so should be a ${expected}, but is ${typeof reading.value}`);
    }
    if (typeof reading.value === 'number' && !Number.isFinite(reading.value)) {
      problems.push(`"${reading.key}" is not a finite number`);
    }
  }
  return problems;
}

/** Exercises one capability the way the gateway and automations will. */
async function capabilityProblems(session: DeviceSession, name: CapabilityName, settleMs: number): Promise<string[]> {
  const problems: string[] = [];
  const stamped = (value: { at?: unknown } | null, what: string) => {
    if (value !== null && !isIso(value.at)) problems.push(`${what} has no valid time`);
  };

  switch (name) {
    case 'switch': {
      const impl = session.capability('switch')!;
      const before = impl.state();
      stamped(before, 'switch.state()');
      if (!['on', 'off', 'last', 'unknown'].includes(impl.bootBehaviour())) problems.push('switch.bootBehaviour() is not a known value');
      if (!before) {
        problems.push('switch.state() is still unknown after the simulator settled');
        break;
      }
      const result = await impl.set(!before.on);
      if (!result.accepted) {
        problems.push(`switch.set was refused by the simulator: ${result.error}`);
        break;
      }
      if (!(await eventually(() => impl.state()?.on === !before.on, settleMs))) {
        problems.push('switch.set was accepted, but state() never showed the change');
      }
      await impl.set(before.on);
      break;
    }

    case 'outlets': {
      const impl = session.capability('outlets')!;
      const before = impl.read();
      stamped(before, 'outlets.read()');
      const outlet = before?.outlets.find((candidate) => candidate.on !== null);
      if (!outlet) {
        problems.push('outlets.read() shows no outlet in a known state after the simulator settled');
        break;
      }
      const result = await impl.set(outlet.id, !outlet.on);
      if (!result.accepted) {
        problems.push(`outlets.set was refused by the simulator: ${result.error}`);
        break;
      }
      const moved = () => impl.read()?.outlets.find((candidate) => candidate.id === outlet.id)?.on === !outlet.on;
      if (!(await eventually(moved, settleMs))) problems.push(`outlets.set("${outlet.id}") never showed the change`);
      await impl.set(outlet.id, Boolean(outlet.on));
      break;
    }

    case 'powerMeter':
      stamped(session.capability('powerMeter')!.read(), 'powerMeter.read()');
      break;
    case 'battery': {
      const reading = session.capability('battery')!.read();
      stamped(reading, 'battery.read()');
      const soc = reading?.socPercent;
      if (typeof soc === 'number' && (soc < 0 || soc > 100)) problems.push(`battery.read() gives ${soc} %`);
      break;
    }
    case 'acInput':
      stamped(session.capability('acInput')!.read(), 'acInput.read()');
      break;
    case 'weather.forecast': {
      const hours = session.capability('weather.forecast')!.hourly(24);
      if (!Array.isArray(hours)) problems.push('weather.forecast.hourly() is not a list');
      else for (const hour of hours) if (!isIso(hour.at)) problems.push('a forecast hour has no valid time');
      break;
    }
  }
  return problems.map((message) => `${name}: ${message}`);
}

/**
 * Runs the whole contract against a type's simulator. Empty means it passes.
 */
export async function checkDeviceTypeContract(type: DeviceType<any>, options: ContractOptions = {}): Promise<string[]> {
  const problems = validateDeviceType(type);
  if (problems.length) return problems; // a type that does not declare itself properly cannot be exercised
  const settleMs = options.settleMs ?? 3_000;

  const { context, stop } = simulatorContext(type, options);
  let session: DeviceSession;
  try {
    session = await Promise.race([
      type.createSimulator(context),
      sleep(5_000).then(() => {
        throw new Error('did not open within 5 s');
      }),
    ]);
  } catch (error) {
    stop();
    return [`the simulator could not be opened: ${(error as Error).message}`];
  }

  try {
    const health = session.health();
    if (!['connected', 'connecting', 'offline', 'unconfigured', 'error'].includes(health.status)) {
      problems.push(`health() gives an unknown status "${health.status}"`);
    }
    if (!health.detail?.trim()) problems.push('health() gives no sentence explaining itself');

    const answered = await eventually(() => session.readings().some((reading) => reading.value !== null), settleMs);
    if (!answered) problems.push(`the simulator produced no readings within ${settleMs} ms`);
    problems.push(...readingProblems(session.readings(), type.telemetry));

    for (const name of CAPABILITY_NAMES) {
      const offered = session.capability(name) !== null;
      const declared = type.capabilities.includes(name);
      if (declared && !offered) problems.push(`declares "${name}" but the session does not offer it`);
      if (!declared && offered) problems.push(`offers "${name}" without declaring it`);
    }
    for (const name of type.capabilities) {
      if (session.capability(name)) problems.push(...(await capabilityProblems(session, name, settleMs)));
    }

    if (type.settings) {
      if (!session.readSettings || !session.writeSettings) {
        problems.push('declares settings but the session cannot read and write them');
      } else {
        const values = await eventually(() => session.readSettings!() !== null, settleMs).then(() => session.readSettings!());
        if (!values) {
          problems.push('readSettings() is still null after the simulator settled');
        } else {
          const valid = validateConfig(type.settings.schema, values);
          if (!valid.ok) problems.push(`readSettings() gives values its own schema rejects: ${valid.issues.map((i) => i.message).join('; ')}`);
          // The round trip: write one setting back as it is, and it must come back unchanged.
          const [field, value] = Object.entries(values).find(([, v]) => v !== undefined) ?? [];
          if (field !== undefined) {
            const after = await session.writeSettings({ [field]: value });
            if (after?.[field] !== value) problems.push(`writing "${field}" back as it was changed it to ${String(after?.[field])}`);
          }
        }
      }
    } else if (session.readSettings || session.writeSettings) {
      problems.push('reads or writes settings without declaring a settings schema');
    }
  } finally {
    await session.close().catch((error: unknown) => problems.push(`close() failed: ${(error as Error).message}`));
    stop();
  }

  return problems;
}
