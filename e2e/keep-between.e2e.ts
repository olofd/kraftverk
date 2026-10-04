import { expect, test, type APIRequestContext } from '@playwright/test';

import { addSimulated, fastServer, link, unique } from './helpers';

/*
  The owner's station, kept between two levels by the plug that feeds it —
  end to end, on a running server whose home's clock runs 1000 times real
  time (playwright.config.ts): hours of it in seconds.

  As the owner has it: an AFERIY P280 (2048 Wh, no packs, charged at 900 W up
  to 60 %, its own cut-off at 2 %) plugged into an ATORCH S1W that feeds its
  mains, and the shared "Charge between two levels" at 5 and 30 %, each side
  held 2 minutes, let act. Both devices simulated; nothing else is: the plug
  is switched through the gateway, the station charges because the plug it
  is plugged into is on and runs down because it is off, and every pause,
  hold and freshness rule keeps the home's one clock. Its load is heavier
  than the owner's, so a cycle is hours, not days.

  It starts at 60 %: off, once it has been at 30 % or above for 2 minutes;
  down to under 5 % for 2 minutes, on; up to 30 % for 2 minutes, off; and
  round again.
*/

const LOW = 5;
const HIGH = 30;
/** The station's own cut-off, as the owner's is set: the floor the automation must keep it off. */
const FLOOR = 2;

async function readings(api: APIRequestContext, id: string): Promise<Map<string, unknown>> {
  const device = await (await api.get(`/api/devices/${id}`)).json();
  return new Map((device.readings as { key: string; value: unknown }[]).map((reading) => [reading.key, reading.value]));
}

/** A request the app asks a yes for: asked, then answered yes. */
async function confirmed(api: APIRequestContext, method: 'PATCH' | 'POST', path: string, data: Record<string, unknown>) {
  let response = await api.fetch(path, { method, data });
  if (response.status() === 409) {
    const asked = await response.json();
    if (asked.needsConfirmation) response = await api.fetch(path, { method, data: { ...data, confirmation: asked.needsConfirmation } });
  }
  expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBe(true);
  return response.json();
}

test('a station kept between 5 and 30 % by the plug that feeds it, round and round', async () => {
  const { api, rate } = await fastServer();
  const began = Date.now();

  // The owner's two devices, simulated: the station as theirs is, the plug its mains is plugged into.
  const station = await addSimulated(api, 'aferiy.p280', unique('AFERIY P280'), undefined, { level: 60, packs: 0, acLoadWatts: 600 });
  const plug = await addSimulated(api, 'atorch.s1w', unique('SmartPlug P280'));
  await link(api, { device: plug.id, part: 'main' }, { device: station.id, part: 'input.ac' });
  // Set as the owner's is, through the gateway as its settings screen does.
  await confirmed(api, 'PATCH', `/api/devices/${station.id}/attributes`, { patch: { chargeLimit: 60, acChargingWatts: 900, dischargeFloor: FLOOR } });

  // The shared recipe as the app copies it, at the owner's levels and holds.
  const copied = await (await api.post('/api/automations/recipes/standard.charge-between/copy', { data: { params: { low: LOW, lowMinutes: 2, high: HIGH, highMinutes: 2 } } })).json();
  const rule = copied.rule ?? copied;
  expect(rule.when.map((trigger: { id?: string }) => trigger.id)).toEqual(['low', 'high']);
  const name = unique('Keep the P280 between 5 and 30 %');
  const made = await confirmed(api, 'POST', '/api/automations', {
    name,
    rule,
    roles: { battery: { device: station.id, part: 'main' }, charger: { device: plug.id, part: 'main' } },
    starts: {},
    timeZone: 'Europe/Stockholm',
  });
  expect(made.problems).toEqual([]);
  await confirmed(api, 'PATCH', `/api/automations/${made.id}`, { mode: 'act' });

  // Watched as it goes: each time the plug is switched; how low and how high the charge got once it cycles.
  const switches: boolean[] = [];
  let lowest = 100;
  let highest = 0;
  let last: boolean | null = null;
  const deadline = Date.now() + 50_000;
  // Off (it starts on, above 30 %), on, off, on, off: two whole cycles.
  while (switches.length < 5 && Date.now() < deadline) {
    const [now, relay] = await Promise.all([readings(api, station.id), readings(api, plug.id)]);
    const soc = Number(now.get('soc'));
    const on = relay.get('relay') === true;
    if (last !== null && on !== last) switches.push(on);
    last = on;
    if (Number.isFinite(soc)) {
      lowest = Math.min(lowest, soc);
      if (switches.includes(true)) highest = Math.max(highest, soc);
    }
    // The station's outlets never cut: it never reached its own floor.
    expect(now.get('outlet.ac.on'), `the AC outlets went off at ${soc} %`).toBe(true);
    // Looked at often, not without pause: the server keeps the home's time on the one thread these questions take.
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(switches).toEqual([false, true, false, true, false]);
  // Kept off its floor, and not far past its high level: the window held.
  expect(lowest).toBeGreaterThan(FLOOR);
  expect(highest).toBeLessThan(HIGH + 5);

  // Its runs, as it kept them: each started by one of its two triggers once it had held 2 minutes, deciding on
  // the charge it saw then — on below 5 %, off at 30 % or above — and each switch verified: the station's mains
  // came and went with the plug.
  const { runs } = await (await api.get(`/api/automations/${made.id}/runs?limit=20`)).json();
  const acted = (runs as { outcome: string; summary: string; why: string; saw: string[]; at: string }[]).reverse().filter((run) => run.outcome !== 'idle');
  const told = JSON.stringify(acted.map((run) => [run.at, run.outcome, run.summary, run.why, run.saw]));
  expect(acted.map((run) => run.outcome), told).toEqual(['acted', 'acted', 'acted', 'acted', 'acted']);
  acted.forEach((run, index) => {
    const on = index % 2 === 1;
    const charge = Number(/Charge ([\d.]+)/.exec(run.saw.join(' '))?.[1]);
    expect(run.summary, told).toMatch(on ? /^Turned .+ on/ : /^Turned .+ off/);
    if (on) {
      expect(run.why, told).toContain('charge is below 5 %, for 2 min');
      expect(charge, told).toBeLessThan(LOW);
    } else {
      expect(run.why, told).toContain('charge is at least 30 %, for 2 min');
      expect(charge, told).toBeGreaterThanOrEqual(HIGH);
    }
  });

  // Hours of the home's time, in seconds of ours.
  const lived = (Date.parse(acted.at(-1)!.at) - Date.parse(acted[0]!.at)) / 3_600_000;
  console.log(`Two cycles: ${lived.toFixed(1)} h of the home's time in ${((Date.now() - began) / 1000).toFixed(1)} s, at ${rate}×; the charge between ${lowest} and ${highest} %`);
  expect(lived).toBeGreaterThan(2);
  await api.dispose();
});
