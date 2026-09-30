import { expect, test } from '@playwright/test';

import { addSimulated, answer, press, unique, whose } from './helpers';

/*
  Sequences built in the editor (docs/AUTOMATION-EDITOR.md): the owner's
  charging chain copied from its recipe, its parts chosen, started, followed,
  and put on the home page; and one built from nothing, block by block, that
  changes a setting and starts another automation, waiting for it to end.
*/

const HEADERS = { 'x-kraftverk-client': 'app' };

/** Picks, in the picker called `label`, the option that reads `option`. */
async function pick(page: import('@playwright/test').Page, label: string, option: string) {
  await page.getByRole('button', { name: new RegExp(`^${label}: .*Choose$`) }).last().click();
  await page.getByText(option, { exact: true }).last().click();
}

test('start charging: copied from its recipe, its parts chosen, started, followed — and on the home page and its device', async ({ page, request }) => {
  const station = await addSimulated(request, 'aferiy.p280', unique('Garage P280'));
  const plug = await addSimulated(request, 'tuya.zigbee-plug', unique('Scooter plug'));

  await page.goto('/automations');
  await press(page, 'New automation');
  // A new one starts from nothing, or from a recipe copied.
  await expect(page.getByText('Nothing', { exact: true })).toBeVisible();
  await press(page, 'Start charging');

  // The recipe's blocks, each yours to change; its parts still to choose.
  await expect(page.getByRole('listitem', { name: /^Wait until: Wait until the charger’s plug can be reached/ })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('What powers the charger: choose one of your devices');
  await pick(page, 'What powers the charger', `${station.name} — AC outlets`);
  await pick(page, 'The charger’s plug', plug.name);
  await expect(page.getByRole('status')).toContainText('It can run as it is');
  const name = unique('Charge the scooter');
  await page.getByLabel('Name').fill(name);
  await press(page, 'Create');

  const card = page.getByRole('region', { name });
  await expect(card.getByText('Made from “Start charging”')).toBeVisible();
  await expect(card.getByText('What it does')).toBeVisible();
  // The step, not the sentence above it that says the same: one name for a part everywhere.
  await expect(card.getByText(`Turn ${station.name} — AC outlets on`, { exact: true }).first()).toBeVisible();
  await expect(card.getByText(/If a step does not succeed, or you stop it/i)).toBeVisible();

  // Only watching on its own, it still runs when you start it — said, and asked, first.
  await card.getByRole('button', { name: `Start ${name}` }).click();
  expect(await answer(page, true)).toContain('started by you it acts');
  // It runs, and ends: the last run, each step as it went.
  await expect(card.getByText(/^Last run/)).toBeVisible({ timeout: 20_000 });
  await expect(card.getByText(`Turn ${plug.name} on`).first()).toBeVisible();
  await expect(card.getByText(/^At once — /).first()).toBeVisible();

  // Its history: the run, started by its owner.
  await card.getByText('History', { exact: true }).click();
  await expect(card.getByText(/^by e2e-admin/).first()).toBeVisible();

  // Put on the home page: a shortcut there to start it.
  await card.getByRole('switch', { name: 'On the home page' }).click();
  await expect(card.getByText('A shortcut to start it is on your home page.')).toBeVisible();
  await page.goto('/');
  await expect(page.getByText('Shortcuts', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: `Start ${name}` })).toBeVisible();

  // The plug's page offers it, to start from there.
  await page.goto(`/device/${plug.id}`);
  await expect(page.getByRole('button', { name: `Start ${name}` })).toBeVisible();
});

test('built from nothing: a time, a setting changed, and another automation started and waited for', async ({ page, request }) => {
  const plug = await addSimulated(request, 'tuya.zigbee-plug', unique('Scooter plug'));
  const meter = await addSimulated(request, 'atorch.s1w', unique('ATORCH'));
  // The automation it starts: one step, made straight through the API.
  const child = unique('Plug on');
  const made = await request.post('/api/automations', {
    headers: HEADERS,
    data: {
      name: child,
      rule: {
        roles: { plug: { label: 'Plug', description: 'The plug', capabilities: ['switch'] } },
        params: { fields: {} },
        when: [],
        then: [{ command: { role: 'plug', capability: 'switch', command: 'set', args: { on: { value: true } } } }],
      },
      roles: { plug: { device: plug.id, part: 'main' } },
      starts: {},
      timeZone: 'Europe/Stockholm',
    },
  });
  expect(made.ok(), await made.text()).toBe(true);

  await page.goto('/automation/new');
  await press(page, 'Nothing');
  // Nothing in it yet: it says so, and what it still needs.
  await expect(page.getByRole('status')).toContainText('What it does: it does nothing');
  await expect(page.getByRole('status')).toContainText('Nothing yet.');
  const name = unique('Morning');
  await page.getByLabel('Name').fill(name);

  // What starts it on its own: seven in the morning, on weekdays.
  await press(page, 'Add a trigger');
  await page.getByRole('button', { name: 'Add: At a time' }).click();
  await page.getByLabel('Hour').fill('7');
  await page.getByRole('radio', { name: 'Weekdays' }).click();

  // A setting the meter keeps: its brightness.
  await press(page, 'Add a step');
  await page.getByRole('button', { name: 'Add: Change a setting' }).click();
  await pick(page, 'Which part', meter.name);
  await pick(page, 'Which setting', 'Brightness');
  await page.getByLabel('Set it to').fill('7');

  // Another automation, started and waited for.
  await press(page, 'Add a step');
  await page.getByRole('button', { name: 'Add: Start another automation' }).click();
  await pick(page, 'Which automation', child);
  await page.getByRole('radio', { name: 'Wait until it ends' }).click();

  const status = page.getByRole('status');
  await expect(status).toContainText('It can run as it is');
  await expect(status).toContainText(`At 07:00 on weekdays, set ${whose(meter.name)} Brightness to 7`);
  await expect(status).toContainText(`start “${child}” and wait until it ends — at most 10 min`);
  await press(page, 'Create');

  // Started: it changes the setting, then runs the other to its end.
  const card = page.getByRole('region', { name });
  await card.getByRole('button', { name: `Start ${name}` }).click();
  await answer(page, true);
  await expect(card.getByText(/^Last run/)).toBeVisible({ timeout: 20_000 });
  await expect(card.getByText(`Started “${child}”`).first()).toBeVisible();

  // The one it started says who started it.
  const started = page.getByRole('region', { name: child });
  await expect(started.getByText(/^Last run/)).toBeVisible();
  await started.getByText('History', { exact: true }).click();
  await expect(started.getByText(new RegExp(`by “${name}”`)).first()).toBeVisible();
});

test('through the night: a window of the day, across midnight, is what starts it', async ({ page, request }) => {
  const plug = await addSimulated(request, 'tuya.zigbee-plug', unique('Scooter plug'));
  await page.goto('/automation/new');
  await press(page, 'Nothing');
  const name = unique('Night charge');
  await page.getByLabel('Name').fill(name);

  // When the clock is between 23:00 and 05:00.
  await press(page, 'Add a trigger');
  await page.getByRole('button', { name: 'Add: When something holds' }).click();
  await page.getByRole('radio', { name: 'Time of day' }).click();
  await page.getByLabel('From: hour').fill('23');
  await page.getByLabel('Until: hour').fill('5');
  await expect(page.getByText('Across midnight: from 23:00 until 05:00 the next morning.')).toBeVisible();

  // The plug on.
  await press(page, 'Add a step');
  await page.getByRole('button', { name: 'Add: Switch or send' }).click();
  await pick(page, 'Which part', plug.name);

  const status = page.getByRole('status');
  await expect(status).toContainText('It can run as it is');
  await expect(status).toContainText(`When it is between 23:00 and 05:00, turn ${plug.name} on.`);
  await press(page, 'Create');

  // Right now: the window, and whether the clock is in it.
  const card = page.getByRole('region', { name });
  await expect(card.getByText('Right now')).toBeVisible();
  await expect(card.getByText('It is between 23:00 and 05:00', { exact: true })).toBeVisible();
});
