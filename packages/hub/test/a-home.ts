import { expect } from 'bun:test';

import { ApiError, type Caller, type CheckOutcome, type DeviceView, type KraftverkApi } from '@kraftverk/api-contract';
import { plainSecrets, type SqlDatabase } from '@kraftverk/store';

import { createHub, installedFrom, type Hub } from '../src/index.ts';
import { busDefinition, FakeBus, lampProtocol, lampType, MACHINE_NODE, makeHubType, relayedLampType, testIntegration, type HubWatch } from '../src/testing.ts';
import { forecastContribution, forecastType, phoneType, plugType, stationType } from './kinds.ts';
import { testDatabase } from './home.ts';

/*
  A home as the hub's tests ask it: a database of its own in memory, the
  lamp on a pretend bus, and the station, plug and forecast of `kinds.ts`,
  each added the simulated way — asked through its interface
  (`hub.as(caller)`), as the server's routes and an app ask it. Built the
  way the server builds one, and not started: only the bus runs.
*/

/** The person the home is asked as: olof, signed in on the account u-olof. */
const OLOF: Caller = { kind: 'person', name: 'olof', account: 'u-olof' };
/** Another person, on another account. */
export const GUEST: Caller = { kind: 'person', name: 'guest', account: 'u-guest' };

/** One cipher for an export's secrets, opened by its passphrase and by nothing else: the real one is the place's, and tested there. */
const sealing = {
  seal: async (passphrase: string, value: string) => `sealed:v1:${btoa(JSON.stringify([passphrase, value]))}`,
  open: async (passphrase: string, sealed: string) => {
    const [given, value] = JSON.parse(atob(sealed.slice('sealed:v1:'.length))) as [string, string];
    if (given !== passphrase) throw new Error('That passphrase does not open it');
    return value;
  },
};

export type TestHome = {
  hub: Hub;
  bus: FakeBus;
  /** What is behind the test hub, when bridges were asked for. */
  bridged: HubWatch;
  database: SqlDatabase;
  /** The home, asked as olof. */
  home: KraftverkApi;
  /** The home, asked as someone else. */
  as(caller: Caller): KraftverkApi;
  /** A lamp on the bus, answering — or as told. */
  lampAt(address: string, lamp?: Partial<{ serial: string; model: string; on: boolean; answers: boolean }>): void;
  /** Setup walked to the check: the draft, and what the check found. */
  checked(options?: { typeId?: string; methodId?: string; address?: string }): Promise<{ id: string; check: CheckOutcome }>;
  /** A device added through setup: a lamp on the bus unless told otherwise. */
  added(name: string, options?: { typeId?: string; methodId?: string; address?: string; save?: { secretsExportable?: boolean } }): Promise<DeviceView>;
  stop(): Promise<void>;
};

/**
 * A home with every test kind installed: the lamp on the bus, and the
 * station, plug and forecast, simulated. With `bridges`, also the test hub —
 * an account, a bridge — and the lamp reached only through it. With
 * `background`, the bus is watched all the time, as the home network is.
 */
export async function aHome(options: { readOnly?: boolean; bridges?: boolean; background?: boolean } = {}): Promise<TestHome> {
  const database = testDatabase();
  const bus = new FakeBus();
  const hubType = makeHubType();
  const bridging = options.bridges ? [{ type: hubType.type }, { type: relayedLampType }] : [];
  const installed = installedFrom(
    {
      integrations: [{ ...testIntegration({ type: lampType }, { type: stationType }, { type: plugType }, { type: phoneType }, { type: forecastType, automation: forecastContribution }, ...bridging), protocols: [lampProtocol] }],

      // The bus as a radio that must scan; or, with `background`, as something that costs nothing to watch.
      transports: [{ definition: { ...busDefinition, background: options.background ?? false }, create: () => bus }],
    },
    { platform: 'system', context: { env: {}, log: () => {}, audit: () => {} } }
  );
  expect(installed.types.refused).toEqual([]);
  // Only the bus: nothing else is started, and nothing reaches a radio or the network.
  await installed.transports.startAll(['bus']);
  const hub = createHub({
    database,
    secrets: plainSecrets,
    sealing,
    installed,
    node: MACHINE_NODE,
    readOnly: () => options.readOnly ?? false,
    http: () => Promise.reject(new Error('no network in these tests')),
    gateway: { verifyTimeoutMs: 300 },
    log: () => {},
  });
  const home = copying(hub.as(OLOF));

  const lampAt: TestHome['lampAt'] = (address, lamp = {}) => {
    bus.lamps.set(address, { serial: address.toUpperCase(), model: 'L1', on: true, answers: true, ...lamp });
    bus.announce();
  };

  const checked: TestHome['checked'] = async (given = {}) => {
    const typeId = given.typeId ?? 'test.lamp';
    const draft = await home.setup.start({ typeId, methodId: given.methodId ?? (typeId === 'test.lamp' ? 'bus' : 'simulated') });
    // A simulated device has nothing to choose: there is only its simulator.
    if (draft.plan.some((step) => step.kind === 'choose')) await home.setup.choose(draft.id, { address: given.address ?? 'lamp-1' });
    return { id: draft.id, check: await home.setup.check(draft.id) };
  };

  const added: TestHome['added'] = async (name, given = {}) => {
    const { id } = await checked(given);
    return home.setup.save(id, { name, ...given.save });
  };

  return {
    hub,
    bus,
    bridged: hubType.watch,
    database,
    home,
    as: (caller) => copying(hub.as(caller)),
    lampAt,
    checked,
    added,
    stop: async () => {
      await hub.stop();
      database.close();
    },
  };
}

/**
 * The home's interface, every answer a copy — as it is over HTTP or a
 * message port. In the process an answer can be the home's own object (a
 * recipe the library keeps, a draft's check), and bun's `toMatchObject`
 * with `expect.objectContaining` changes what it matches: a test must not
 * change the home it asks.
 */
function copying<T extends object>(api: T): T {
  return new Proxy(api, {
    get(target, key, receiver) {
      const value: unknown = Reflect.get(target, key, receiver);
      if (typeof value === 'function') {
        return (...args: unknown[]) => {
          const answer: unknown = (value as (...given: unknown[]) => unknown).apply(target, args);
          return answer instanceof Promise ? answer.then((resolved: unknown) => (resolved === undefined ? resolved : structuredClone(resolved))) : answer;
        };
      }
      return value !== null && typeof value === 'object' ? copying(value) : value;
    },
  });
}

/** What a call was refused with: an ApiError, its kind and its words. */
export async function refusal(work: Promise<unknown>): Promise<ApiError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('It was not refused');
}

/** A moment for a session to take its first reading. */
export const settle = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));
