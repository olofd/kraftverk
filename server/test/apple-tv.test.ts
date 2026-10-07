import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Caller, KraftverkApi } from '@kraftverk/api-contract';
import type { Rule } from '@kraftverk/automation';
import { savedDeviceId, type Transport } from '@kraftverk/device-sdk';
import { createHub, DeviceTypeRegistry, passphraseSealing, ProtocolRegistry, TransportHost, type Hub } from '@kraftverk/hub';
import { MACHINE_NODE } from '@kraftverk/hub/testing';
import { PIN, playedAppleTv } from '@kraftverk/integration-apple-media/testing';
import { AuditLog } from '@kraftverk/store';
import lan from '@kraftverk/transport-lan';

import { openDatabase } from '../src/platform/database.ts';
import { discoverIntegrations } from '../src/platform/packages.ts';
import { serverSecrets } from '../src/platform/secrets.ts';

/*
  Step 20 of docs/PLAN-INTEGRATIONS.md, done when an automation pauses an
  Apple TV through the gateway: the installed packages as the server finds
  them, a home network that reaches one TV — played, Companion byte for
  byte — and the home asked as the app asks it. Found and paired in
  setup, with the PIN it shows; saved; then an automation pauses it, and
  the gateway reads back that it has.

  Here, beside the server's own tests and not among them: it assembles the
  core with real packages, as the running server does, which the core's
  own code and tests never do (scripts/architecture.mjs).
*/

const dir = mkdtempSync(join(tmpdir(), 'kraftverk-apple-tv-'));
const OLOF: Caller = { kind: 'person', name: 'olof', account: 'u-olof' };
const tv = playedAppleTv();

/** The home network, reaching the one TV: every connection to it, one of its own. */
const homeNetwork = (): Transport => ({
  definition: lan,
  available: () => ({ ok: true }),
  start: async () => undefined,
  stop: async () => undefined,
  open: async () => tv.connect(),
});

let hub: Hub;
let home: KraftverkApi;
let close: () => void;

beforeAll(async () => {
  const { database } = openDatabase(join(dir, 'home.db'));
  const protocols = new ProtocolRegistry();
  const types = new DeviceTypeRegistry();
  const transports = new TransportHost({ platform: 'system', context: { env: {}, log: () => {}, audit: () => {} } });
  transports.install(lan, { create: homeNetwork });
  await discoverIntegrations({ types, protocols });
  await transports.startAll(['lan']);
  hub = createHub({
    database,
    audit: new AuditLog(database),
    secrets: serverSecrets(null),
    sealing: passphraseSealing,
    installed: { types, protocols, transports },
    readOnly: () => false,
    http: () => Promise.reject(new Error('no network in these tests')),
    node: MACHINE_NODE,
    gateway: { verifyTimeoutMs: 2_000 },
  });
  home = hub.as(OLOF);
  close = () => database.close();
});

afterAll(async () => {
  await hub.stop();
  close();
  rmSync(dir, { recursive: true, force: true });
});

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, what: string, ms = 5_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > end) throw new Error(`Waited for ${what}: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('an automation pauses an Apple TV, through the gateway', async () => {
  // Setup: the TV chosen by its address, paired with the PIN it shows, read once, and saved.
  const draft = await home.setup.start({ typeId: 'apple-media.tv', methodId: 'companion' });
  expect(draft.plan.map((step) => step.id)).toEqual(['ready', 'choose', 'credentials', 'check']);
  await home.setup.choose(draft.id, { manual: '192.0.2.70' });
  const asked = await home.setup.action(draft.id, 'credentials', 'pair', {});
  expect(asked).toMatchObject({ ok: true, detail: 'The TV shows a PIN', ask: { schema: { fields: { pin: { type: 'string' } } } } });
  // What the next turn needs stays with the home: the app never sees it.
  expect(asked.ask?.carry).toBeUndefined();
  expect(await home.setup.action(draft.id, 'credentials', 'pair', { pin: PIN })).toMatchObject({ ok: true, detail: 'Paired: the TV lists it as “kraftverk”.' });
  expect(tv.pairings.size).toBe(1);
  expect(await home.setup.check(draft.id)).toMatchObject({ outcome: 'new', summary: 'An Apple TV, paired and answering: awake.' });
  const saved = await home.setup.save(draft.id, { name: 'Living room TV' });
  expect(saved.capabilities).toEqual(['switch', 'mediaPlayback', 'keypadInput', 'applicationLauncher', 'volume']);

  // Its session: verified on its own connection, and what it tells as it changes.
  const playing = await until(
    () => home.devices.get(saved.id),
    (device) => device.readings.find((reading) => reading.key === 'playing')?.value === true,
    'it to say it plays',
  );
  expect(playing.health.status).toBe('connected');

  // The automation: pause it.
  const rule: Rule = {
    roles: { tv: { label: 'TV', capabilities: ['mediaPlayback'] } },
    params: { fields: {} },
    when: [],
    then: [{ command: { role: 'tv', capability: 'mediaPlayback', command: 'set', args: { playing: { value: false } } } }],
  };
  const made = await home.automations.create({ name: 'Pause the TV', rule, roles: { tv: { device: savedDeviceId(saved.id), part: 'main' } }, groups: {}, starts: {}, madeFrom: null, timeZone: 'Europe/Stockholm' });
  await home.automations.start(made.id);
  const run = await until(
    async () => (await home.automations.list()).find((one) => one.id === made.id)!,
    (one) => !one.running && one.lastRun !== null,
    'the run to end',
  );
  expect(run.lastRun).toMatchObject({ outcome: 'acted' });
  expect(run.lastRun!.steps.map((step) => `${step.kind} ${step.outcome}`)).toEqual(['command done']);
  // Paused on the TV — and read back as paused, which is what the gateway waited for.
  expect(tv.state.playing).toBe(false);
  expect((await home.devices.get(saved.id)).readings.find((reading) => reading.key === 'playing')?.value).toBe(false);
}, 30_000);
