import { describe, expect, test } from 'bun:test';

import { checkDeviceTypeContract, fakeByteChannel, fakeConnection } from '@kraftverk/device-sdk/testing';
import { CMD, encodeFrame, FrameReader, hmacSha256, sessionKeyOf } from '@kraftverk/protocol-tuya-local';

import plugType, { ZIGBEE_PLUG } from '../src/type.ts';

/**
 * The Zigbee plug keeps the device-type contract, and is read and switched
 * through its gateway the way the real one is (README.md): Tuya 3.4 to the
 * gateway, with the gateway's key, the plug named by its Zigbee address.
 */

const KEY = '0123456789abcdef';
const CID = 'a4c1380000000001';
const bytes = (text: string) => new TextEncoder().encode(text);

type Dps = Record<string, number | boolean | string>;

/**
 * A 3.4 gateway with the plug behind it: its memory of the plug `dps`, keeping
 * what it is sent. A query answers from that memory. A refresh naming the plug
 * in a list has it measure: what it measures now (`measure`) and the memory does
 * not have is pushed, and kept.
 */
function gateway(dps: Dps) {
  const key = bytes(KEY);
  let reader = new FrameReader('3.4', key);
  let sessionKey: Uint8Array = key;
  let clientNonce: Uint8Array = new Uint8Array();
  const remoteNonce = bytes('fedcba9876543210');
  const sent: Dps[] = [];
  const refreshes: unknown[] = [];
  let measuring: Dps = {};
  let queries = 0;
  const frame = (command: number, payload: Uint8Array, withKey = sessionKey) => encodeFrame({ version: '3.4', key: withKey, sequence: 1, command, payload });
  const channel = fakeByteChannel((written) => {
    const out: Uint8Array[] = [];
    for (const got of reader.push(written)) {
      if (got.command === CMD.SESS_KEY_NEG_START) {
        clientNonce = got.payload;
        const proof = hmacSha256(key, got.payload);
        const answer = new Uint8Array(48);
        answer.set(remoteNonce);
        answer.set(proof, 16);
        out.push(frame(CMD.SESS_KEY_NEG_RESP, answer, key));
      } else if (got.command === CMD.SESS_KEY_NEG_FINISH) {
        const mixed = new Uint8Array(16).map((_, i) => clientNonce[i]! ^ remoteNonce[i]!);
        sessionKey = sessionKeyOf('3.4', key, clientNonce, mixed);
        reader = new FrameReader('3.4', sessionKey);
      } else if (got.command === CMD.DP_QUERY_NEW) {
        queries += 1;
        const asked = JSON.parse(new TextDecoder().decode(got.payload)) as { cid?: string };
        // Asked of itself, a gateway answers with its own datapoints: not the plug's.
        out.push(frame(CMD.DP_QUERY_NEW, bytes(JSON.stringify(asked.cid === CID ? { dps, cid: CID } : { dps: { '4': false, '32': 'normal' } }))));
      } else if (got.command === CMD.CONTROL_NEW) {
        const asked = JSON.parse(new TextDecoder().decode(got.payload)) as { data: { cid: string; dps: Dps } };
        if (asked.data.cid !== CID) continue;
        sent.push(asked.data.dps);
        Object.assign(dps, asked.data.dps);
        out.push(frame(CMD.CONTROL_NEW, new Uint8Array()));
        out.push(frame(CMD.STATUS, bytes(JSON.stringify({ protocol: 4, t: 1, data: { dps: asked.data.dps, cid: CID } }))));
      } else if (got.command === CMD.UPDATEDPS) {
        const asked = JSON.parse(new TextDecoder().decode(got.payload)) as { dpId: number[]; cid?: unknown };
        refreshes.push(asked);
        out.push(frame(CMD.UPDATEDPS, new Uint8Array()));
        if (!Array.isArray(asked.cid) || !asked.cid.includes(CID)) continue;
        const changed = Object.fromEntries(asked.dpId.map(String).filter((dp) => measuring[dp] !== undefined && measuring[dp] !== dps[dp]).map((dp) => [dp, measuring[dp]!]));
        if (!Object.keys(changed).length) continue;
        Object.assign(dps, changed);
        out.push(frame(CMD.STATUS, bytes(JSON.stringify({ protocol: 4, t: 1, data: { dps: changed, cid: CID, type: 'query' } }))));
      }
    }
    return out;
  });
  /** Says something unasked, as the gateway does: a push, a report of which plugs it reaches. */
  const say = (command: number, json: unknown) => channel.push(frame(command, bytes(JSON.stringify(json))));
  return {
    channel,
    sent,
    refreshes,
    say,
    /** What the plug measures, when something has it measure. */
    measure: (now: Dps) => void (measuring = now),
    /** How often the plug has been asked for its datapoints. */
    get queries() {
      return queries;
    },
  };
}

const over = (channel: ReturnType<typeof gateway>['channel']) =>
  fakeConnection({
    method: 'lan',
    protocol: 'tuya-local',
    transport: 'lan',
    address: `192.0.2.74#${CID}`,
    channel,
    config: { deviceId: 'bf7c0000000000000000zp', protocolVersion: '3.4' },
    secrets: { localKey: KEY },
  });

const quiet = { info: () => {}, warn: () => {}, error: () => {} };

/** A real session over a scripted gateway, the way a holder opens one. */
async function session(dps: Dps) {
  const device = gateway(dps);
  // What it asks to run on a clock, run when a test says: its poll first.
  const scheduled: (() => unknown)[] = [];
  const opened = await plugType.createSession({
    config: { profile: ZIGBEE_PLUG.id, pollSeconds: 60 },
    connection: over(device.channel),
    log: quiet,
    readOnly: false,
    store: { get: () => undefined, set: () => {}, delete: () => {} },
    schedule: (_ms: number, run: () => unknown) => void scheduled.push(run),
    changed: () => {},
    event: () => {},
  } as never);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const reading = (key: string) => opened.readings().find((candidate) => candidate.key === key);
  const value = (key: string) => reading(key)?.value;
  const run = async (index: number) => {
    await scheduled[index]!();
    await new Promise((resolve) => setTimeout(resolve, 100));
  };
  // Its poll, and the tick that asks often while someone waits on its readings.
  const poll = () => run(0);
  const freshTick = () => run(1);
  return { device, opened, value, reading, poll, freshTick, scheduled };
}

const MAPPED: Dps = { '1': true, '9': 0, '17': 43230, '18': 4310, '19': 9970, '20': 2310, '27': 'memory', '28': 'relay', '29': false };

describe('the Tuya Zigbee plug', () => {
  test('keeps the device-type contract, reached through its gateway', async () => {
    const connection = () => over(gateway({ ...MAPPED }).channel);
    expect(await checkDeviceTypeContract(plugType, { settleMs: 1_500, connections: [connection] })).toEqual([]);
    expect(plugType.meta.category).toBe('smart-plug');
    expect(plugType.connections).toEqual([expect.objectContaining({ protocol: 'tuya-local', transport: 'lan', label: 'Its Zigbee gateway' })]);
  });

  test('its check reads the plug through the gateway, in the units its app shows', async () => {
    const found = await plugType.identify(over(gateway({ ...MAPPED }).channel), { config: {}, log: quiet, signal: AbortSignal.timeout(10_000) });
    expect(found.identity).toBe('tuya-local:bf7c0000000000000000zp');
    expect(found.summary).toBe('Answering through its gateway, Tuya 3.4: the relay is on, drawing 997 W.');
  });

  test('reads as the app does: 997 W, 4.31 A, 231 V, 43.23 kWh; its settings in words', async () => {
    const { value, opened } = await session({ ...MAPPED });
    expect([value('watts'), value('amps'), value('volts'), value('kwh')]).toEqual([997, 4.31, 231, 43.23]);
    expect([value('afterPowerCut'), value('indicator'), value('buttonLocked'), value('countdown')]).toEqual(['asItWas', 'showsOn', false, 0]);
    await opened.close();
  });

  test('switches on DP 1, named by its Zigbee address', async () => {
    const { device, opened, value } = await session({ ...MAPPED });
    expect(await opened.command({ part: 'main', capability: 'switch', command: 'set', args: { on: false } })).toEqual({ accepted: true });
    expect(device.sent).toEqual([{ '1': false }]);
    expect(value('relay')).toBe(false);
    await opened.close();
  });

  test('switched, the plug’s own word stands over the gateway’s memory of before — no flicker back to off', async () => {
    const dps: Dps = { ...MAPPED, '1': false };
    const { device, opened, value, poll } = await session(dps);
    const asked = device.queries;
    expect(await opened.command({ part: 'main', capability: 'switch', command: 'set', args: { on: true } })).toEqual({ accepted: true });
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Not asked again at once: the plug says it itself.
    expect(device.queries).toBe(asked);
    expect(value('relay')).toBe(true);

    // The gateway's memory lags: asked now, it still says off — which is not taken over what the plug just pushed.
    dps['1'] = false;
    await poll();
    expect(value('relay')).toBe(true);
    // Its other datapoints are still taken from the answer.
    dps['19'] = 2750;
    await poll();
    expect(value('watts')).toBe(275);
    await opened.close();
  });

  test('switched off, it draws nothing — whatever load the gateway still remembers', async () => {
    const dps: Dps = { ...MAPPED, '18': 1179, '19': 2690 };
    const { opened, value } = await session(dps);
    expect(value('watts')).toBe(269);
    await opened.command({ part: 'main', capability: 'switch', command: 'set', args: { on: false } });
    expect(value('relay')).toBe(false);
    expect(value('watts')).toBe(0);
    expect(value('amps')).toBe(0);
    // The voltage at its socket is still what it is.
    expect(value('volts')).toBe(231);
    await opened.close();
  });

  test('while its gateway says it cannot reach the plug, the gateway’s memory is not taken for the plug’s word', async () => {
    const dps = { ...MAPPED };
    const { device, opened, value, reading, poll } = await session(dps);
    expect(value('watts')).toBe(997);
    const before = reading('watts')!.at;

    device.say(CMD.LAN_EXT_STREAM, { reqType: 'subdev_online_stat_report', data: { online: [], offline: [CID] } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(opened.health()).toMatchObject({ status: 'offline', detail: 'Its gateway cannot reach it: is it plugged in?' });

    // Asked now, the gateway answers from what it remembers: not a reading, so it ages as a silent plug's does.
    dps['19'] = 0;
    await new Promise((resolve) => setTimeout(resolve, 5));
    await poll();
    expect(value('watts')).toBe(997);
    expect(reading('watts')!.at).toBe(before);

    // The plug itself speaking ends it: reachable again, and its word taken.
    device.say(CMD.STATUS, { protocol: 4, t: 2, data: { dps: { '19': 0 }, cid: CID } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(value('watts')).toBe(0);
    expect(opened.health().status).not.toBe('offline');
    await opened.close();
  });

  test('its power is as old as the plug\'s last measurement — the gateway answering the same from memory does not make it new', async () => {
    // As on the owner's server after the gateway lost its power: the plug drew 240 W, the gateway kept answering 0 W.
    const dps = { ...MAPPED, '18': 0, '19': 0 };
    const { device, value, reading, poll } = await session(dps);
    const measured = reading('watts')!.at;
    const relayAt = reading('relay')!.at;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await poll();
    // Answered again from memory: the same 0 W, as old as it was; the relay, the gateway's answer, now.
    expect(value('watts')).toBe(0);
    expect(reading('watts')!.at).toBe(measured);
    expect(reading('amps')!.at).toBe(measured);
    expect(Date.parse(reading('relay')!.at)).toBeGreaterThan(Date.parse(relayAt));
    // A changed value in an answer is new: something had the plug measure, and told the gateway.
    dps['19'] = 2310;
    await poll();
    expect(value('watts')).toBe(231);
    const changed = reading('watts')!.at;
    expect(Date.parse(changed)).toBeGreaterThan(Date.parse(measured));
    // And the plug measuring — a push — is new.
    await new Promise((resolve) => setTimeout(resolve, 20));
    device.say(CMD.STATUS, { protocol: 4, t: 2, data: { dps: { '19': 2400, '18': 1050 }, cid: CID } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(value('watts')).toBe(240);
    expect(Date.parse(reading('watts')!.at)).toBeGreaterThan(Date.parse(changed));
  });

  test('each poll has the plug measure: what changed comes at once, as measured now; the same measured again keeps its time', async () => {
    // As on the owner's server: the gateway remembers 0 W, the plug draws 240 W, and says so only when asked.
    const dps = { ...MAPPED, '18': 0, '19': 0 };
    const { device, value, reading, poll } = await session(dps);
    const before = reading('watts')!.at;
    device.measure({ '18': 1050, '19': 2400, '20': 2310 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await poll();
    expect(value('watts')).toBe(240);
    expect(value('amps')).toBe(1.05);
    const measured = reading('watts')!.at;
    expect(Date.parse(measured)).toBeGreaterThan(Date.parse(before));
    // Asked as Smart Life asks, by its Zigbee address in a list, for what it measures.
    expect(device.refreshes.at(-1)).toEqual({ dpId: [18, 19, 20, 17], cid: [CID] });
    // Measured the same again: nothing is pushed, and nothing proves it measured — its time stays.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await poll();
    expect(value('watts')).toBe(240);
    expect(reading('watts')!.at).toBe(measured);
  });

  test('a push of any of its meter is all of it measured: 0 W that stays 0 W is as new as the current that moved; energy keeps its own time', async () => {
    // As on the owner's server: nothing drawing, the current flickering 0–30 mA, the power 0 W throughout.
    const dps = { ...MAPPED, '18': 0, '19': 0 };
    const { device, reading, poll } = await session(dps);
    const before = { watts: reading('watts')!.at, kwh: reading('kwh')!.at };
    device.measure({ '18': 30, '19': 0, '20': 2310 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await poll();
    expect(device.refreshes).not.toHaveLength(0);
    expect(reading('amps')!.value).toBe(0.03);
    expect(Date.parse(reading('watts')!.at)).toBeGreaterThan(Date.parse(before.watts));
    expect(reading('volts')!.at).toBe(reading('watts')!.at);
    expect(reading('kwh')!.at).toBe(before.kwh);
  });

  test('all who wait on its readings share one lease and one clock: asked often until the latest of them', async () => {
    const { device, opened, freshTick, scheduled } = await session({ ...MAPPED });
    const clocks = scheduled.length;
    const asked = device.queries;
    // Nobody waits: the tick asks nothing.
    await freshTick();
    expect(device.queries).toBe(asked);

    // Two wait, one longer: an earlier end does not cut the later one short, and no second clock starts.
    opened.wantFresh!(Date.now() + 60_000);
    opened.wantFresh!(Date.now() + 1);
    expect(scheduled.length).toBe(clocks);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await freshTick();
    await freshTick();
    expect(device.queries).toBe(asked + 2);
    await opened.close();
  });

  test('writes a setting in the plug’s words: the light to find it in the dark, the button locked', async () => {
    const { device, opened } = await session({ ...MAPPED });
    await opened.write!({ indicator: 'findInDark' });
    await opened.write!({ buttonLocked: true });
    expect(device.sent).toEqual([{ '28': 'pos' }, { '29': true }]);
    await opened.close();
  });

  test('offers the power cut, the light and the button as settings; the countdown only read', () => {
    const attributes = plugType.describe({ profile: ZIGBEE_PLUG.id, pollSeconds: 15 }).attributes;
    expect(attributes.filter((attribute) => attribute.access === 'write').map((attribute) => attribute.key)).toEqual(['afterPowerCut', 'indicator', 'buttonLocked']);
    expect(attributes.find((attribute) => attribute.key === 'countdown')).toMatchObject({ category: 'diagnostic' });
  });
});
