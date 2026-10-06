import { expect, test, type Page } from '@playwright/test';

import { addSimulated, answer, link, press, unique, whose } from './helpers';

const SOC = { read: { role: 'battery', means: 'charge' } };

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
  await page.getByRole('button', { name: 'New automation' }).click();
  await press(page, 'Charge between two levels');

  // Nothing chosen yet: it says what is missing, in the group it is about, rather than greying out Create in silence.
  const status = page.getByRole('status');
  const uses = page.getByRole('region', { name: 'Uses' });
  await expect(uses.getByText('Battery: choose one of your devices')).toBeVisible();
  await expect(uses.getByText('What charges it: choose one of your devices')).toBeVisible();
  await expect(page.getByText('2 things to fix')).toBeVisible();
  await pick(page, 'Battery', station.name);
  await pick(page, 'What charges it', plug.name);
  await expect(status).toContainText('It can run as it is');

  // The recipe's values are in its blocks now: the window is the owner's to change.
  await expect(status).toContainText(`${whose(station.name)} charge is below 15 %`);
  await press(page, 'Create');
  // Named after its recipe when not renamed, and opened on its own page: only watching on its own, at first.
  await expect(page.getByRole('heading', { level: 1, name: 'Charge between two levels' })).toBeVisible();
  const main = page.getByRole('main');
  await expect(main.getByText('Made from “Charge between two levels”.')).toBeVisible();
  await expect(main.getByRole('radio', { name: 'Watch only' })).toHaveAttribute('aria-checked', 'true');

  // Right now: each condition it waits for, how it stands, and the reading it stands on.
  const now = page.getByRole('region', { name: 'Right now' });
  await expect(now.getByText(`${whose(station.name)} charge is below 15 % for 2 min`, { exact: true })).toBeVisible();
  await expect(now.getByText(`${whose(station.name)} charge is at least 50 % for 2 min`, { exact: true })).toBeVisible();
  await expect(now.getByText(new RegExp(`^${station.name}: Charge \\d`))).toBeVisible();
  // Once it has acted, what is switched by hand stays: until it is asked to keep things so.
  await expect(now.getByText(/what you switch by hand stays until one turns to yes again/)).toBeVisible();

  // Edit turns its page into its form: the same groups, editable. Cancel, asked first, keeps it as it was.
  await main.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByLabel('Name').fill('Not kept');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await answer(page, true)).toContain('What you changed is not kept');
  await expect(page.getByRole('heading', { level: 1, name: 'Charge between two levels' })).toBeVisible();

  // Changed, in its form: each trigger with what it does beneath it — on below the low level, off at the high one —
  // and the automation's own steps only for when it is started by hand; a new name, saved with Enter, back on its page.
  const renamed = unique('Charge window');
  await main.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.getByRole('list', { name: 'What trigger 1 does' }).getByRole('button', { name: /^Open step: Turn .+ on$/ })).toBeVisible();
  await expect(page.getByRole('list', { name: 'What trigger 2 does' }).getByRole('button', { name: /^Open step: Turn .+ off$/ })).toBeVisible();
  await expect(page.getByText(/^Each trigger says what it does\./)).toBeVisible();
  await page.getByLabel('Name').fill(renamed);
  await expect(page.getByRole('status')).toContainText('It can run as it is');
  await page.getByLabel('Name').press('Enter');
  await expect(page.getByRole('heading', { level: 1, name: renamed })).toBeVisible();
  // On its page: what each does, beneath it — and no steps of its own besides.
  const when = page.getByRole('region', { name: 'When' });
  await expect(when.getByText(/^Turn .+ on$/)).toBeVisible();
  await expect(when.getByText(/^Turn .+ off$/)).toBeVisible();
  await expect(page.getByRole('region', { name: 'Does' })).toHaveCount(0);

  // Kept so, on its page: a look every ten minutes — not asked, while it only watches.
  await main.getByRole('radio', { name: '10 min' }).click();
  await expect(now.getByText(/Every 10 min it also runs again while one still holds/)).toBeVisible();
  await expect(now.getByText(/^Looks again \d/)).toBeVisible();

  // Its history: made, then changed, and what changed.
  const activity = page.getByRole('region', { name: 'Activity' });
  await activity.getByText('History', { exact: true }).click();
  await expect(activity.getByText(/Made the automation/)).toBeVisible();
  await expect(activity.getByText('Changed', { exact: true }).first()).toBeVisible();
  await expect(activity.getByText('Keep it so: off → every 10 min')).toBeVisible();

  // What it would do now, under ⋯: what it would send, why, and each condition as it stands.
  await main.getByRole('button', { name: 'More' }).click();
  await main.getByRole('button', { name: 'What would it do now?' }).click();
  const checked = page.getByRole('region', { name: 'If it ran now' });
  await expect(checked.getByText('Asked what it would do now')).toBeVisible();
  // Asked by hand, it does what is due now: the station starts at 68 %, past its high level, so the charger goes off.
  await expect(checked.getByText(/^Would turn .+ off$/).first()).toBeVisible();

  // Rehearsed on the last week: this server has kept almost none of it, and says what it could.
  await main.getByRole('button', { name: 'More' }).click();
  await main.getByRole('button', { name: 'Rehearse on last week' }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'On the last week' })).toBeVisible();
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

  // Opened from its card in the list.
  await page.goto('/automations');
  await page.getByRole('button', { name: new RegExp(`^${name}: `) }).click();
  const main = page.getByRole('main');
  const act = main.getByRole('radio', { name: 'Act' });

  // No: nothing changes.
  await act.click();
  expect(await answer(page, false)).toContain('on its own');
  await expect(main.getByRole('radio', { name: 'Watch only' })).toHaveAttribute('aria-checked', 'true');

  // Yes: it acts.
  await act.click();
  await answer(page, true);
  await expect(act).toHaveAttribute('aria-checked', 'true');

  // Deleted from under ⋯, asked first: back to the list, and gone from it.
  await main.getByRole('button', { name: 'More' }).click();
  await main.getByRole('button', { name: 'Delete' }).click();
  expect(await answer(page, true)).toContain('It stops, and is gone');
  await expect(page).toHaveURL(/\/automations$/);
  await expect(page.getByRole('group', { name })).toHaveCount(0);
});
