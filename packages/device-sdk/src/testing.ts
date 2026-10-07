import type { ByteChannel, Channel, ChannelMessage, MessageChannel } from './channel.ts';
import { validateDescription } from './check-description.ts';
import { REAL_CLOCK } from './clock.ts';
import type { Bridge } from './bridge.ts';
import { simulatedMethodOf, type BridgedConnection, type DirectConnection, type OpenConnection } from './connection.ts';
import { attributeMeaning, capabilitiesOf, capabilityIn, checkAttributeValue, currentForOf, isCurrent, partsOf, type AttributeSpec, type DeviceDescription } from './description.ts';
import type { DeviceContext, DeviceSession, DeviceType } from './device-type.ts';
import { savedDeviceId } from './ids.ts';
import { configDefaults, validateConfig, valueTypeOf, type ConfigSchema, type ConfigValues } from './schema.ts';
import { validateDeviceType } from './validate.ts';
import { checkValue, type ScalarValueType, type Value } from './values.ts';

/**
 * The contract suite: what every device type must do, checked against its
 * simulator (docs/ARCHITECTURE.md §7).
 *
 * `validateDeviceType` checks what a type declares; this checks that its
 * sessions keep those declarations. Generic from end to end — it knows no
 * capability by name: it checks that readings are the attributes described,
 * hold values their types allow and are current when they arrive; that every
 * command which `sets` an on/off attribute really moves it; that every query
 * and every tool that only reads answers in the type it declares; that a
 * written attribute survives a round trip; and that every event raised is
 * declared.
 * Given a connection to a fake device, it checks `identify` too. A type passes
 * when the returned list is empty:
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

export type RaisedEvent = { id: string; data?: Readonly<Record<string, Value>>; part?: string };

/** A context with nothing real behind it: memory for storage, no network, no radios. */
export function simulatorContext<Config extends ConfigValues = ConfigValues>(
  type: DeviceType<Config>,
  options: ContractOptions = {}
): { context: DeviceContext<Config>; stop: () => void; events: RaisedEvent[] } {
  const timers: ReturnType<typeof setInterval>[] = [];
  const store = new Map<string, unknown>();
  const events: RaisedEvent[] = [];
  const quiet = () => undefined;

  const validated = validateConfig(type.config, options.config ?? configDefaults(type.config));
  const config = validated.ok ? validated.value : { ...(options.config ?? {}) };

  const context: DeviceContext<Config> = {
    deviceId: savedDeviceId(`contract:${type.id}`),
    // Validated against the type's own schema, so it is the type's config.
    config: config as Config,
    connection: null,
    // Its simulated world as a new one is set up: its own choices' defaults, fed by nothing simulated, in real time.
    simulation: { config: configDefaults(simulatedMethodOf(type).config ?? { fields: {} }), fed: () => null },
    clock: REAL_CLOCK,
    store: {
      get: <T>(key: string) => (store.has(key) ? (store.get(key) as T) : null),
      set: (key, value) => void store.set(key, value),
      delete: (key) => void store.delete(key),
    },
    log: { info: quiet, warn: quiet, error: quiet },
    readOnly: false,
    allowRawFrames: false,
    platform: 'system',
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
    changed: quiet,
    event: (id, data, part) => void events.push({ id, data, part }),
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

/** A value to give an argument when the suite has no reason to prefer one. */
function sampleArgument(type: ScalarValueType): Value {
  switch (type.type) {
    case 'number':
      return type.min ?? (type.max !== undefined ? Math.min(0, type.max) : 1);
    case 'boolean':
      return true;
    case 'enum':
      return type.options[0]?.value ?? null;
    case 'string':
      return '';
    case 'timestamp':
      return new Date().toISOString();
  }
}

/** Input for a tool: its defaults, and a sample for anything required without one. */
const sampleInput = (schema: ConfigSchema | undefined): ConfigValues => ({
  ...Object.fromEntries(
    Object.entries(schema?.fields ?? {}).flatMap(([name, field]) => (field.required ? [[name, sampleArgument(valueTypeOf(field)) as string | number | boolean]] : []))
  ),
  ...configDefaults(schema ?? { fields: {} }),
});

/** Runs the whole contract against a type's simulator. Empty means it passes. */
export async function checkDeviceTypeContract(type: DeviceType<any>, options: ContractOptions = {}): Promise<string[]> {
  const problems = validateDeviceType(type);
  if (problems.length) return problems; // a type that does not declare itself properly cannot be exercised
  const settleMs = options.settleMs ?? 3_000;

  const { context, stop, events: raised } = simulatorContext(type, options);
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

  const declared = type.describe(context.config);
  const describe = (): DeviceDescription => session.description?.() ?? declared;

  try {
    const health = session.health();
    if (!['connected', 'connecting', 'offline', 'unconfigured', 'error'].includes(health.status)) {
      problems.push(`health() gives an unknown status "${health.status}"`);
    }
    if (!health.detail?.trim()) problems.push('health() gives no sentence explaining itself');
    // Who holds it, and over what, is its holder's to say: the same session runs in every holder.
    for (const field of ['owner', 'transport'] as const) {
      if (field in health) problems.push(`health() says "${field}", which only its holder knows`);
    }

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
      // `at` is when the value was observed. A value that is out of date the moment it arrives has the time it is about there instead.
      else if (isIso(reading.at) && !isCurrent(attribute, reading)) {
        problems.push(`"${reading.key}" was observed at ${reading.at}, longer ago than it stays current (${Math.round(currentForOf(attribute) / 1000)} s): a reading's time is when it was observed`);
      }
    }

    const info = session.info?.() ?? null;
    for (const [component, version] of Object.entries(info?.firmware ?? {})) {
      if (typeof version !== 'string') problems.push(`info() gives firmware "${component}" as ${typeof version}, not text`);
    }

    // Every command that sets an on/off attribute: flip it, see it move, put it back.
    const valueOf = (key: string) => session.readings().find((reading) => reading.key === key)?.value ?? null;
    for (const part of partsOf(description)) {
      for (const name of capabilitiesOf(description, part.id)) {
        const spec = capabilityIn(description, name);
        if (!spec) continue;
        for (const [command, declaredCommand] of Object.entries(spec.commands)) {
          const [argument, attributeName] = Object.entries(declaredCommand.sets)[0] ?? [];
          const means = attributeName ? spec.attributes[attributeName]?.means : undefined;
          const target: AttributeSpec | null = means ? attributeMeaning(description, part.id, means) : null;
          const where = `${part.id}: ${name}.${command}`;
          if (!argument || !target || target.value.type !== 'boolean') continue;
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
        for (const [query, declaredQuery] of Object.entries(spec.queries)) {
          if (!session.query) {
            problems.push(`${part.id} offers ${name}, which answers "${query}", but the session answers no queries`);
            continue;
          }
          const args = Object.fromEntries(Object.entries(declaredQuery.args).map(([key, type]) => [key, sampleArgument(type)]));
          try {
            const answer = await session.query({ part: part.id, capability: name, query, args });
            const checked = checkValue(declaredQuery.answer, answer);
            if (!checked.ok) problems.push(`${part.id}: ${name}.${query} answered something else: its answer ${checked.problem}`);
          } catch (error) {
            problems.push(`${part.id}: ${name}.${query} failed: ${(error as Error).message}`);
          }
        }
      }
    }

    // A bridge's simulator brings members, as its real sessions do, and links each.
    if (type.bridge) {
      if (!session.bridge) problems.push('it is a bridge, but its session offers no members (`bridge`)');
      else {
        const members = await eventually(() => session.bridge!.members().length > 0, settleMs);
        if (!members) problems.push(`it is a bridge, but its simulator brought no members within ${settleMs} ms`);
        for (const member of session.bridge.members()) {
          if (!member.key?.trim()) problems.push('a member behind it has no key');
          try {
            (await session.bridge.link(member.key, () => undefined)).close();
          } catch (error) {
            problems.push(`member "${member.key}" could not be linked: ${(error as Error).message}`);
          }
        }
      }
    } else if (session.bridge) problems.push('its session offers members (`bridge`), but its type does not say it is a bridge');

    // Every tool it runs is one its type declares; every one that only reads answers in the type it declares.
    const declaredTools = type.tools ?? {};
    for (const [name, run] of Object.entries(session.tools ?? {})) {
      const tool = declaredTools[name];
      if (!tool) {
        problems.push(`runs a tool "${name}", which its type does not declare`);
        continue;
      }
      if (typeof run !== 'function') problems.push(`tool "${name}" cannot be run`);
      else if (!tool.writes) {
        try {
          const checked = checkValue(tool.answer, await run(sampleInput(tool.input)));
          if (!checked.ok) problems.push(`tool "${name}" answered something else: its answer ${checked.problem}`);
        } catch (error) {
          problems.push(`tool "${name}" failed: ${(error as Error).message}`);
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
      const value = valueOf(known.key) as Exclude<Value, null>;
      const after = await session.write({ [known.key]: value });
      if (after[known.key] !== value) problems.push(`writing "${known.key}" back as it was changed it to ${String(after[known.key])}`);
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
    if (connection.kind === 'direct' && found.identity && !found.identity.startsWith(`${connection.protocol}:`)) {
      problems.push(`${where}: identity "${found.identity}" is not namespaced by its protocol "${connection.protocol}"`);
    }
    if (!found.summary?.trim()) problems.push(`${where}: no sentence to show the user`);
    return problems;
  } catch (error) {
    return [`${where} failed: ${(error as Error).message}`];
  } finally {
    if (connection.kind === 'direct') await connection.channel.close().catch(() => undefined);
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

/** A message a device on a fake channel publishes: kept on its topic when `retain`, as a broker keeps it. */
export type FakeMessage = { topic: string; payload: Uint8Array; retain?: boolean };

/**
 * A messages channel with a device on the other end, as a broker carries it:
 * `respond` is given each publish and returns the messages the device
 * publishes back; `say` is the device publishing unasked. What it publishes
 * with `retain` is kept on its topic and sent first to every later
 * subscription, as MQTT does.
 */
export function fakeMessageChannel(
  respond: (topic: string, payload: Uint8Array) => readonly FakeMessage[]
): MessageChannel & {
  published: { topic: string; payload: Uint8Array }[];
  setConnected(connected: boolean): void;
  say(message: FakeMessage): void;
} {
  const subscriptions: { filter: string; listener: (message: ChannelMessage) => void }[] = [];
  const state = listeners<boolean>();
  let connected = true;
  const published: { topic: string; payload: Uint8Array }[] = [];
  const kept = new Map<string, FakeMessage>();
  const deliver = (message: FakeMessage) => {
    if (message.retain) {
      if (message.payload.length === 0) kept.delete(message.topic);
      else kept.set(message.topic, message);
    }
    const at = new Date().toISOString();
    for (const { filter, listener } of [...subscriptions]) if (matches(filter, message.topic)) listener({ topic: message.topic, payload: message.payload, at });
  };
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
      // What is kept on its topics first, a moment later, as a broker sends it.
      const first = [...kept.values()].filter((message) => matches(filter, message.topic));
      setTimeout(() => {
        const at = new Date().toISOString();
        for (const message of first) if (subscriptions.includes(entry)) listener({ topic: message.topic, payload: message.payload, at });
      }, 0);
      return () => void subscriptions.splice(subscriptions.indexOf(entry), 1);
    },
    async publish(topic, payload) {
      if (!connected) throw new Error('Not connected');
      published.push({ topic, payload });
      const replies = respond(topic, payload);
      setTimeout(() => {
        for (const reply of replies) deliver(reply);
      }, 0);
    },
    say: deliver,
    setConnected(next) {
      connected = next;
      state.emit(next);
    },
    async close() {
      connected = false;
    },
  };
}

/** An open connection through a bridge, for `identify` and a session: it links through the bridge, as its holder's would. */
export function bridgedConnection(bridge: Bridge, input: { method: string; address: string; config?: ConfigValues }): BridgedConnection {
  return { kind: 'bridged', method: input.method, address: input.address, config: input.config ?? {}, platform: 'system', link: (changed) => bridge.link(input.address, changed) };
}

/** An open connection over a fake channel, for `identify` and a session. */
export function fakeConnection(input: {
  method: string;
  protocol: string;
  transport: string;
  address: string;
  channel: Channel;
  config?: ConfigValues;
  secrets?: Record<string, string>;
}): DirectConnection {
  // What a session keeps, kept here: a test reads it back as a holder would.
  const secrets: Record<string, string> = { ...input.secrets };
  return {
    kind: 'direct',
    method: input.method,
    protocol: input.protocol,
    transport: input.transport,
    address: input.address,
    channel: input.channel,
    config: input.config ?? {},
    secrets: {
      get: (field) => secrets[field] ?? null,
      set: (field, value) => {
        if (value === null) delete secrets[field];
        else secrets[field] = value;
      },
    },
    platform: 'system',
  };
}
