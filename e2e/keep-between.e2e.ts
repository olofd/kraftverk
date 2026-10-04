import { expect, test, type APIRequestContext } from '@playwright/test';

import { addSimulated, link, unique } from './helpers';

/*
  The owner's station, kept between two levels by the plug that feeds it —
  end to end, on the running server: a simulated AFERIY P280 set up as the
  real one (2048 Wh, no packs, charged at 900 W up to 60 %, cut off at 2 %),
  plugged into a simulated ATORCH S1W that feeds its mains, and the shared
  "Charge between two levels" recipe at 5 and 30 %, let act.

  Simulated time runs 200 times as fast, and the station carries a heavier
  load than the real one, so a cycle takes seconds; nothing else is faked.
  The plug is switched through the gateway; the station charges because the
  plug it is plugged into is on, and stops because it is off.

  It starts at 60 %: down to under 5 %, the plug on; up to 30 %, the plug off
  once it has stayed there for its hold; down and up again. Its holds in real
  minutes (2 min each side, as the owner's) are the engine's to keep, proven
  on its own clock in packages/hub/test/engine.test.ts: here, where a second
  is minutes of the station's time, the high side holds 3 s and the low side
  none, so the station never nears its own cut-off.
*/

const HEADERS = { 'x-kraftverk-client': 'app' };
const SPEED = 200;
const LOW = 5;
const HIGH = 30;
/** The station's own cut-off, as the owner's is set: the floor the automation must keep it off. */
const FLOOR = 2;

type Reading = { key: string; value: unknown };

async function readings(request: APIRequestContext, id: string): Promise<Map<string, unknown>> {
  const device = await (await request.get(`/api/devices/${id}`, { headers: HEADERS })).json();
  return new Map((device.readings as Reading[]).map((reading) => [reading.key, reading.value]));
}

/** A request the app asks a yes for: asked, then answered yes. */
async function confirmed(request: APIRequestContext, method: 'PATCH' | 'POST', path: string, data: Record<string, unknown>) {
  let response = await request.fetch(path, { method, headers: HEADERS, data });
  if (response.status() === 409) {
    const asked = await response.json();
    if (asked.needsConfirmation) response = await request.fetch(path, { method, headers: HEADERS, data: { ...data, confirmation: asked.needsConfirmation } });
  }
  expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBe(true);
  return response.json();
}

test('a station kept between 5 and 30 % by the plug that feeds it, round and round', async ({ page, request }) => {
  test.setTimeout(240_000);

  // The owner's two devices, simulated: the station as theirs is, the plug its mains is plugged into.
  const station = await addSimulated(request, 'aferiy.p280', unique('AFERIY P280'), undefined, { speed: SPEED, level: 60, packs: 0, acLoadWatts: 600 });
  const plug = await addSimulated(request, 'atorch.s1w', unique('SmartPlug P280'), undefined, { speed: SPEED });
  await link(request, { device: plug.id, part: 'main' }, { device: station.id, part: 'input.ac' });
  // Set as the owner's is, through the gateway as its settings screen does.
  await confirmed(request, 'PATCH', `/api/devices/${station.id}/attributes`, { patch: { chargeLimit: 60, acChargingWatts: 900, dischargeFloor: FLOOR } });

  // The shared recipe, as the app copies it: 5 % below, 30 % at or above, the high side held 3 s.
  const copied = await (
    await request.post('/api/automations/recipes/standard.charge-between/copy', { headers: HEADERS, data: { params: { low: LOW, lowMinutes: 0, high: HIGH, highMinutes: 0 } } })
  ).json();
  const rule = copied.rule ?? copied;
  rule.when[1].heldForMinutes = { value: 0.05 };
  expect(rule.when.map((trigger: { id?: string }) => trigger.id)).toEqual(['low', 'high']);
  const name = unique('Keep the P280 between 5 and 30 %');
  const made = await confirmed(request, 'POST', '/api/automations', {
    name,
    rule,
    roles: { battery: { device: station.id, part: 'main' }, charger: { device: plug.id, part: 'main' } },
    starts: {},
    timeZone: 'Europe/Stockholm',
  });
  expect(made.problems).toEqual([]);
  await confirmed(request, 'PATCH', `/api/automations/${made.id}`, { mode: 'act' });

  // Watched as it goes: each time the plug is switched, at what charge; and how low and high the charge ever got.
  const switches: { on: boolean; soc: number }[] = [];
  let lowest = 100;
  let highest = 0;
  let last: boolean | null = null;
  const deadline = Date.now() + 220_000;
  // Off (it starts on, above 30 %), on, off, on, off: two whole cycles.
  while (switches.length < 5 && Date.now() < deadline) {
    const [now, relay] = await Promise.all([readings(request, station.id), readings(request, plug.id)]);
    const soc = Number(now.get('soc'));
    const on = relay.get('relay') === true;
    if (Number.isFinite(soc)) {
      lowest = Math.min(lowest, soc);
      // How high it charged, once it has charged at all: from 60 % down is not the window yet.
      if (switches.some((one) => one.on)) highest = Math.max(highest, soc);
    }
    if (last !== null && on !== last) switches.push({ on, soc });
    last = on;
    // The station's outlets never cut: it never reached its own floor.
    expect(now.get('outlet.ac.on'), `the AC outlets went off at ${soc} %`).toBe(true);
    await page.waitForTimeout(150);
  }

  expect(switches.map((one) => one.on), JSON.stringify(switches)).toEqual([false, true, false, true, false]);
  // Kept off its floor, and not far past its high level: the window held.
  expect(lowest).toBeGreaterThan(FLOOR);
  expect(highest).toBeLessThan(HIGH + 8);

  // Its runs, as it kept them: each started by one of its two triggers, deciding on the charge it saw then —
  // on below 5 %, off at 30 % or above — and each switch verified: the station's mains came and went with the plug.
  const { runs } = await (await request.get(`/api/automations/${made.id}/runs?limit=20`, { headers: HEADERS })).json();
  const acted = (runs as { outcome: string; summary: string; why: string; saw: string[] }[]).reverse().filter((run) => run.outcome !== 'idle');
  const told = JSON.stringify(acted.map((run) => [run.outcome, run.summary, run.why, run.saw]));
  expect(acted.map((run) => run.outcome), told).toEqual(['acted', 'acted', 'acted', 'acted', 'acted']);
  acted.forEach((run, index) => {
    const on = index % 2 === 1;
    const charge = Number(/Charge ([\d.]+)/.exec(run.saw.join(' '))?.[1]);
    expect(run.summary, told).toMatch(on ? /^Turned .+ on/ : /^Turned .+ off/);
    if (on) {
      expect(run.why, told).toContain('charge is below 5 %');
      expect(charge, told).toBeLessThan(LOW);
    } else {
      expect(run.why, told).toContain('charge is at least 30 %, for 3 s');
      expect(charge, told).toBeGreaterThanOrEqual(HIGH);
    }
  });

  // Its page says why each run ran: which of its triggers started it.
  await page.goto(`/automation/${made.id}`);
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
  await expect(page.getByText(/charge is below 5 %/).first()).toBeVisible();
});
