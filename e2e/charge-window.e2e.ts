import { expect, test, type Page } from '@playwright/test';

import { addSimulated, answer, link, press, unique } from './helpers';

const SOC = { read: { role: 'battery', means: 'battery.soc' } };

/*
  The owner's own case: a P280 charged through the ATORCH that feeds its
  mains, on below 15 %, off at 50 % — a charge window below the lowest limit
  the station's own settings allow. Made in the editor, read back as a
  sentence, and checked against the station as it is now.
*/

/** Picks, in the picker called `label`, the option that reads `option`. */
async function pick(page: Page, label: string, option: string) {
  await page.getByRole('button', { name: new RegExp(`^${label}: .*Choose$`) }).last().click();
  await page.getByText(option, { exact: true }).last().click();
}

test('a charge window of your own, copied from the shared recipe', async ({ page, request }) => {
  const station = await addSimulated(request, 'aferiy.p280', unique('Garage P280'));
  const plug = await addSimulated(request, 'atorch.s1w', unique('ATORCH'));
  await link(request, { device: plug.id, part: 'main' }, { device: station.id, part: 'input.ac' });

  await page.goto('/automations');
  await press(page, 'New automation');
  await press(page, 'Charge between two levels');

  // Nothing chosen yet: it says what is missing rather than greying out Create in silence.
  const status = page.getByRole('status');
  await expect(status).toContainText('Battery: choose one of your devices');
  await expect(status).toContainText('What charges it: choose one of your devices');
  await pick(page, 'Battery', station.name);
  await pick(page, 'What charges it', plug.name);
  await expect(status).toContainText('It can run as it is');

  // The recipe's values are in its blocks now: the window is the owner's to change.
  await expect(status).toContainText(`${station.name}’s charge is below 15 %`);
  await press(page, 'Create');
  // Named after its recipe when not renamed, and read back as what it does.
  let card = page.getByRole('region', { name: 'Charge between two levels' }).last();
  await expect(card.getByText('Made from “Charge between two levels”')).toBeVisible();
  await expect(card.getByText('Only watching')).toBeVisible();

  // Right now: each condition it waits for, how it stands, and the reading it stands on.
  await expect(card.getByText('Right now')).toBeVisible();
  await expect(card.getByText(`${station.name}’s charge is below 15 % for 2 min`, { exact: true })).toBeVisible();
  await expect(card.getByText(`${station.name}’s charge is at least 50 %`, { exact: true }).first()).toBeVisible();
  await expect(card.getByText(new RegExp(`^${station.name}: Charge \\d`)).first()).toBeVisible();
  // Once it has acted, what is switched by hand stays: until it is asked to keep things so.
  await expect(card.getByText(/what you switch by hand stays until one turns to yes again/)).toBeVisible();

  // Changed after it was made, in the editor: a new name.
  const renamed = unique('Charge window');
  await card.getByText('Edit', { exact: true }).click();
  await expect(page.getByText(/^Change “Charge between two levels”/)).toBeVisible();
  await page.getByLabel('Name').fill(renamed);
  await expect(page.getByRole('status')).toContainText('It can run as it is');
  await press(page, 'Save changes');
  card = page.getByRole('region', { name: renamed });
  await expect(card.getByText(renamed, { exact: true })).toBeVisible();

  // Kept so, on the card: a look every ten minutes — not asked, while it only watches.
  await card.getByRole('radio', { name: '10 min' }).click();
  await expect(card.getByText(/Every 10 min it also runs again while one still holds/)).toBeVisible();
  await expect(card.getByText(/^Looks again \d/)).toBeVisible();

  // Its history: made, then changed, and what changed.
  await card.getByText('History', { exact: true }).click();
  await expect(card.getByText(/Made the automation/)).toBeVisible();
  await expect(card.getByText('Changed', { exact: true }).first()).toBeVisible();
  await expect(card.getByText('Keep it so: off → every 10 min')).toBeVisible();

  // What it would do now: what it would send, why, and each condition as it stands.
  await card.getByText('What would it do now?').click();
  await expect(card.getByText('If it ran now')).toBeVisible();
  await expect(card.getByText('Asked what it would do now')).toBeVisible();
  await expect(card.getByText(/^Would turn /).last()).toBeVisible();

  // Rehearsed on the last week: this server has kept almost none of it, and says what it could.
  await card.getByText('Rehearse last week').click();
  await expect(card.getByText('On the last week')).toBeVisible();
});

test('an automation is let act only with a yes, in the app’s own words, and deleted the same way', async ({ page, request }) => {
  const station = await addSimulated(request, 'aferiy.p280', unique('Garage P280'));
  const plug = await addSimulated(request, 'atorch.s1w', unique('ATORCH'));
  const name = unique('Charge window');
  const made = await request.post('/api/automations', {
    headers: { 'x-kraftverk-client': 'app' },
    data: {
      name,
      rule: {
        roles: {
          battery: { label: 'Battery', description: 'The battery', capabilities: ['battery'] },
          charger: { label: 'What charges it', description: 'What charges it', capabilities: ['switch'] },
        },
        params: { fields: {} },
        when: [{ becomes: { compare: 'lt', left: SOC, right: { value: 15 } }, heldForMinutes: { value: 2 } }, { becomes: { compare: 'ge', left: SOC, right: { value: 50 } } }],
        then: [{ command: { role: 'charger', capability: 'switch', command: 'set', args: { on: { compare: 'lt', left: SOC, right: { value: 50 } } } } }],
      },
      roles: { battery: { device: station.id, part: 'main' }, charger: { device: plug.id, part: 'main' } },
      starts: {},
      timeZone: 'Europe/Stockholm',
    },
  });
  expect(made.ok(), await made.text()).toBe(true);

  await page.goto('/automations');
  const card = page.getByRole('region', { name });
  const act = card.getByRole('radio', { name: 'Act' });

  // No: nothing changes.
  await act.click();
  expect(await answer(page, false)).toContain('on its own');
  await expect(card.getByText('Only watching')).toBeVisible();

  // Yes: it acts.
  await act.click();
  await answer(page, true);
  await expect(card.getByText('Acting')).toBeVisible();

  await card.getByRole('button', { name: 'Delete' }).click();
  expect(await answer(page, true)).toContain('It stops, and is gone');
  await expect(page.getByRole('region', { name })).toHaveCount(0);
});
