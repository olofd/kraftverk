import { CAPABILITIES, CAPABILITY_NAMES, type CapabilityCommand, type CapabilityName } from './capabilities.ts';
import type { ByteChannel, ChannelMessage, MessageChannel, OpenConnection } from './connection.ts';
import {
  attributeMeaning,
  capabilitiesOf,
  checkAttributeValue,
  partsOf,
  validateDescription,
  type AttributeSpec,
  type DeviceDescription,
} from './description.ts';
import type { DeviceContextV4, DeviceSessionV4, DeviceTypeV4 } from './device-model.ts';
import type { DeviceContext, DeviceSession, DeviceType } from './device-type.ts';
import { savedDeviceId } from './identity.ts';
import { validateConfig, type ConfigSchema, type ConfigValues } from './schema.ts';
import type { MetricSpec, Reading } from './telemetry.ts';
import { configDefaults, validateDeviceType, validateDeviceTypeV4 } from './validate.ts';
import { checkValue, type Value, type ValueType } from './values.ts';

/**
 * The contract suite: what every device type must do, checked against its
 * simulator (docs/ARCHITECTURE.md §7).
 *
 * `validateDeviceType` checks what a type declares; this checks that its
 * sessions keep those declarations — that the telemetry it reports is the
 * telemetry it declared, that every capability it claims is really there and
 * behaves, and that its settings survive a round trip. Given a connection to a
 * fake device, it checks `identify` too. A type passes when the returned list
 * is empty:
 *
 *   test('keeps the device-type contract', async () => {
 *     expect(await checkDeviceTypeContract(myType)).toEqual([]);
 *   });
 *
 * Deliberately free of any test framework, so it runs under whichever one a
 * package uses. The fake channels below let a protocol or a device type be
 * tested against scripted bytes and messages, with no transport at all.
 */

export type ContractOptions = {
  /** Config for the simulated device. Defaults from the type's schema otherwise. */
  config?: ConfigValues;
  /** How long the simulator may take to produce its first readings. */
  settleMs?: number;
  /**
   * A connection to a fake device, one per method the test covers, to check
   * `identify` against. Built from the channels below.
   */
  connections?: readonly (() => OpenConnection | Promise<OpenConnection>)[];
};

/** A context with nothing real behind it: memory for storage, no network, no radios. */
export function simulatorContext<Config extends ConfigValues = ConfigValues>(
  type: DeviceType<Config> | DeviceTypeV4<Config>,
  options: ContractOptions = {}
): { context: DeviceContext<Config>; stop: () => void; events: string[] } {
  const timers: ReturnType<typeof setInterval>[] = [];
  const store = new Map<string, unknown>();
  const events: string[] = [];
  const quiet = () => undefined;

  const validated = validateConfig(type.config, options.config ?? {});
  const config = validated.ok ? validated.value : { ...(options.config ?? {}) };

  const context: DeviceContext<Config> = {
    deviceId: savedDeviceId(`contract:${type.id}`),
    // Validated against the type's own schema, so it is the type's config.
    config: config as Config,
    connection: null,
    store: {
      get: <T>(key: string) => (store.has(key) ? (store.get(key) as T) : null),
      set: (key, value) => void store.set(key, value),
      delete: (key) => void store.delete(key),
    },
    log: { info: quiet, warn: quiet, error: quiet },
    readOnly: false,
    allowRawFrames: false,
    platform: 'server',
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

  for (const connect of options.connections ?? []) {
    problems.push(...(await identifyProblems(type, await connect(), context.config)));
  }
  return problems;
}

/** Runs `identify` against a fake device, the way the check step will. */
// --- version 4 -------------------------------------------------------------------

/** A value to give an argument when the suite has no reason to prefer one. */
function sampleArgument(type: ValueType): Value {
  switch (type.type) {
    case 'number':
      return type.min ?? (type.max !== undefined ? Math.min(0, type.max) : 1);
    case 'boolean':
      return true;
    case 'enum':
      return type.options[0]?.value ?? null;
    case 'string':
      return '';
  }
}

/**
 * Runs the version-4 contract against a type's simulator (docs/ARCHITECTURE.md
 * §8 step 24). Generic from end to end: it knows no capability by name. It
 * checks the description, that readings are the attributes described and hold
 * values their types allow, that every command which `sets` an on/off
 * attribute really moves it, that every query answers, that a written
 * attribute survives a round trip, and that every event raised is one declared.
 */
export async function checkDeviceTypeV4Contract(type: DeviceTypeV4<any>, options: ContractOptions = {}): Promise<string[]> {
  const problems = validateDeviceTypeV4(type);
  if (problems.length) return problems;
  const settleMs = options.settleMs ?? 3_000;

  const { context: base, stop } = simulatorContext(type, options);
  const raised: { id: string; data?: Readonly<Record<string, Value>>; part?: string }[] = [];
  const context: DeviceContextV4<any> = { ...base, changed: () => undefined, event: (id, data, part) => void raised.push({ id, data, part }) };

  let session: DeviceSessionV4;
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

  const declared = type.describe(context.config ?? configDefaults(type.config));
  const describe = (): DeviceDescription => session.description?.() ?? declared;

  try {
    const health = session.health();
    if (!['connected', 'connecting', 'offline', 'unconfigured', 'error'].includes(health.status)) {
      problems.push(`health() gives an unknown status "${health.status}"`);
    }
    if (!health.detail?.trim()) problems.push('health() gives no sentence explaining itself');

    const answered = await eventually(() => session.readings().some((reading) => reading.value !== null), settleMs);
    if (!answered) problems.push(`the simulator produced no readings within ${settleMs} ms`);

    const reported = session.description?.() ?? null;
    if (reported) problems.push(...validateDescription(reported, type.id).map((message) => `description(): ${message}`));
    const description = describe();
    const byKey = new Map(description.attributes.map((attribute) => [attribute.key, attribute]));

    for (const reading of session.readings()) {
      const attribute = byKey.get(reading.key);
      if (!attribute) {
        problems.push(`reports "${reading.key}", which the description does not have`);
        continue;
      }
      if (!isIso(reading.at)) problems.push(`"${reading.key}" has no valid time`);
      if (reading.value === null) continue;
      const checked = checkAttributeValue(attribute, reading.value);
      if (!checked.ok) problems.push(`"${reading.key}" is ${JSON.stringify(reading.value)}, which ${checked.problem}`);
    }

    const info = session.info?.() ?? null;
    for (const [component, version] of Object.entries(info?.firmware ?? {})) {
      if (typeof version !== 'string') problems.push(`info() gives firmware "${component}" as ${typeof version}, not text`);
    }

    // Every command that sets an on/off attribute: flip it, see it move, put it back.
    const valueOf = (key: string) => session.readings().find((reading) => reading.key === key)?.value ?? null;
    for (const part of partsOf(description)) {
      for (const name of capabilitiesOf(description, part.id)) {
        const spec = CAPABILITIES[name];
        for (const [command, declaredCommand] of Object.entries(spec.commands as Record<string, CapabilityCommand>)) {
          const [argument, attributeName] = Object.entries(declaredCommand.sets ?? {})[0] ?? [];
          const means = attributeName ? (spec.attributes as Record<string, { means: string }>)[attributeName]?.means : undefined;
          const target: AttributeSpec | null = means ? attributeMeaning(description, part.id, means) : null;
          const where = `${part.id}: ${name}.${command}`;
          if (!argument || !target) continue;
          if (target.value.type !== 'boolean') continue;
          const before = valueOf(target.key);
          if (typeof before !== 'boolean') {
            problems.push(`${where}: "${target.key}" is still unknown after the simulator settled`);
            continue;
          }
          const args = { ...Object.fromEntries(Object.entries(declaredCommand.args).map(([key, type]) => [key, sampleArgument(type)])), [argument]: !before };
          const result = await session.command({ part: part.id, capability: name, command, args });
          if (!result.accepted) {
            problems.push(`${where} was refused by the simulator: ${result.error}`);
            continue;
          }
          if (!(await eventually(() => valueOf(target.key) === !before, settleMs))) problems.push(`${where} was accepted, but "${target.key}" never showed the change`);
          await session.command({ part: part.id, capability: name, command, args: { ...args, [argument]: before } });
        }
        for (const [query, declaredQuery] of Object.entries((spec as { queries?: Record<string, { args: Record<string, ValueType> }> }).queries ?? {})) {
          if (!session.query) {
            problems.push(`${part.id} offers ${name}, which answers "${query}", but the session answers no queries`);
            continue;
          }
          const args = Object.fromEntries(Object.entries(declaredQuery.args).map(([key, type]) => [key, sampleArgument(type)]));
          try {
            const answer = await session.query({ part: part.id, capability: name, query, args });
            if (answer === undefined) problems.push(`${part.id}: ${name}.${query} answered nothing`);
          } catch (error) {
            problems.push(`${part.id}: ${name}.${query} failed: ${(error as Error).message}`);
          }
        }
      }
    }

    // A written attribute survives a round trip: written back as it is, it comes back unchanged.
    const writable = description.attributes.filter((attribute) => attribute.access === 'write');
    if (writable.length && !session.write) problems.push('describes attributes that can be written, but the session cannot write');
    if (!writable.length && session.write) problems.push('writes attributes, but describes none that can be written');
    const known = writable.find((attribute) => valueOf(attribute.key) !== null);
    if (session.write && writable.length && !known) problems.push('no attribute that can be written has a value after the simulator settled');
    if (session.write && known) {
      const value = valueOf(known.key);
      const after = await session.write({ [known.key]: value });
      if (after?.[known.key] !== value) problems.push(`writing "${known.key}" back as it was changed it to ${String(after?.[known.key])}`);
    }

    // Every event raised is one the description declares, carrying what it says.
    const events = new Map((describe().events ?? []).map((event) => [event.id, event]));
    for (const event of raised) {
      const spec = events.get(event.id);
      if (!spec) {
        problems.push(`raised event "${event.id}", which the description does not declare`);
        continue;
      }
      for (const [field, value] of Object.entries(event.data ?? {})) {
        const type = spec.data?.[field];
        if (!type) problems.push(`event "${event.id}" carries "${field}", which it does not declare`);
        else if (value !== null && !checkValue(type, value).ok) problems.push(`event "${event.id}" carries "${field}" as ${JSON.stringify(value)}`);
      }
    }
  } finally {
    await session.close().catch((error: unknown) => problems.push(`close() failed: ${(error as Error).message}`));
    stop();
  }

  for (const connect of options.connections ?? []) {
    problems.push(...(await identifyProblems(type, await connect(), context.config)));
  }
  return problems;
}

async function identifyProblems(type: Pick<DeviceType<any>, 'identify' | 'kind'>, connection: OpenConnection, config: ConfigValues): Promise<string[]> {
  const where = `identify over ${connection.method}`;
  const quiet = () => undefined;
  try {
    const found = await Promise.race([
      type.identify(connection, { config, log: { info: quiet, warn: quiet, error: quiet }, signal: AbortSignal.timeout(10_000) }),
      sleep(10_000).then(() => {
        throw new Error('did not answer within 10 s');
      }),
    ]);
    const problems: string[] = [];
    if (type.kind === 'hardware' && !found.identity) problems.push(`${where}: a device must say who it is, and gave no identity`);
    if (found.identity && !found.identity.startsWith(`${connection.protocol}:`)) {
      problems.push(`${where}: identity "${found.identity}" is not namespaced by its protocol "${connection.protocol}"`);
    }
    if (!found.summary?.trim()) problems.push(`${where}: no sentence to show the user`);
    return problems;
  } catch (error) {
    return [`${where} failed: ${(error as Error).message}`];
  } finally {
    await connection.channel.close().catch(() => undefined);
  }
}

// --- fake channels: a device on the other end, scripted -----------------------

/** Listeners, and how to tell them all. */
function listeners<T>() {
  const set = new Set<(value: T) => void>();
  return {
    add(listener: (value: T) => void) {
      set.add(listener);
      return () => void set.delete(listener);
    },
    emit(value: T) {
      for (const listener of [...set]) listener(value);
    },
  };
}

/**
 * A bytes channel with a device on the other end: `respond` is given each
 * write and returns what the device sends back, if anything.
 */
export function fakeByteChannel(respond: (bytes: Uint8Array) => Uint8Array | readonly Uint8Array[] | null): ByteChannel & {
  written: Uint8Array[];
  /** Sends bytes as if the device had spoken unprompted. */
  push(bytes: Uint8Array): void;
  setConnected(connected: boolean): void;
} {
  const data = listeners<Uint8Array>();
  const state = listeners<boolean>();
  let connected = true;
  const written: Uint8Array[] = [];
  return {
    kind: 'bytes',
    written,
    get connected() {
      return connected;
    },
    onConnectedChange: state.add,
    onData: data.add,
    async write(bytes) {
      if (!connected) throw new Error('Not connected');
      written.push(bytes);
      const answer = respond(bytes);
      if (!answer) return;
      const chunks = answer instanceof Uint8Array ? [answer] : answer;
      // Answered on a later turn, as a device would.
      setTimeout(() => chunks.forEach((chunk) => data.emit(chunk)), 0);
    },
    push: (bytes) => data.emit(bytes),
    setConnected(next) {
      connected = next;
      state.emit(next);
    },
    async close() {
      connected = false;
    },
  };
}

/**
 * A messages channel with a device on the other end: `respond` is given each
 * publish and returns the messages the device publishes back.
 */
export function fakeMessageChannel(
  respond: (topic: string, payload: Uint8Array) => readonly { topic: string; payload: Uint8Array }[]
): MessageChannel & { published: { topic: string; payload: Uint8Array }[]; setConnected(connected: boolean): void } {
  const subscriptions: { filter: string; listener: (message: ChannelMessage) => void }[] = [];
  const state = listeners<boolean>();
  let connected = true;
  const published: { topic: string; payload: Uint8Array }[] = [];
  const matches = (filter: string, topic: string): boolean => {
    const f = filter.split('/');
    const t = topic.split('/');
    for (let i = 0; i < f.length; i++) {
      if (f[i] === '#') return true;
      if (f[i] !== '+' && f[i] !== t[i]) return false;
    }
    return f.length === t.length;
  };
  return {
    kind: 'messages',
    published,
    get connected() {
      return connected;
    },
    onConnectedChange: state.add,
    subscribe(filter, listener) {
      const entry = { filter, listener };
      subscriptions.push(entry);
      return () => void subscriptions.splice(subscriptions.indexOf(entry), 1);
    },
    async publish(topic, payload) {
      if (!connected) throw new Error('Not connected');
      published.push({ topic, payload });
      const replies = respond(topic, payload);
      setTimeout(() => {
        for (const reply of replies) {
          const message = { ...reply, at: new Date().toISOString() };
          for (const { filter, listener } of [...subscriptions]) if (matches(filter, reply.topic)) listener(message);
        }
      }, 0);
    },
    setConnected(next) {
      connected = next;
      state.emit(next);
    },
    async close() {
      connected = false;
    },
  };
}

/** An open connection over a fake channel, for `identify` and a session. */
export function fakeConnection(input: {
  method: string;
  protocol: string;
  transport: string;
  address: string;
  channel: OpenConnection['channel'];
  config?: ConfigValues;
  secrets?: Record<string, string>;
}): OpenConnection {
  return {
    method: input.method,
    protocol: input.protocol,
    transport: input.transport,
    address: input.address,
    channel: input.channel,
    config: input.config ?? {},
    secrets: { get: (field) => input.secrets?.[field] ?? null },
    platform: 'server',
  };
}
