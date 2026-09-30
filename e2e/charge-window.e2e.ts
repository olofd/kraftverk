import { expect, test } from '@playwright/test';

import { addSimulated, answer, link, press, unique } from './helpers';

/*
  The owner's own case: a P280 charged through the ATORCH that feeds its
  mains, on below 15 %, off at 50 % — a charge window below the lowest limit
  the station's own settings allow. Made in the editor, read back as a
  sentence, and checked against the station as it is now.
*/

test('a charge window of your own, made from the shared recipe', async ({ page, request }) => {
  const station = await addSimulated(request, 'aferiy.p280', unique('Garage P280'));
  const plug = await addSimulated(request, 'atorch.s1w', unique('ATORCH'));
  await link(request, { device: plug.id, part: 'main' }, { device: station.id, part: 'input.ac' });

  await page.goto('/automations');
  await press(page, 'New automation');
  await press(page, 'Charge between two levels');

  // Nothing chosen yet: it says what is missing rather than greying out Save in silence.
  await expect(page.getByRole('status')).toContainText('Still to choose: battery, what charges it.');
  await press(page, station.name);
  await press(page, plug.name);
  await expect(page.getByRole('status')).toHaveCount(0);

  await press(page, 'Create');
  // Named after its recipe when not named, and read back as what it does.
  await expect(page.getByText(`Charge ${station.name} with ${plug.name}: on when it stays below 15 % for 2 min, off when it reaches 50 %.`)).toBeVisible();
  let card = page.getByRole('region', { name: 'Charge between two levels' }).last();
  await expect(card.getByText('Only watching')).toBeVisible();

  // Right now: each condition it waits for, how it stands, and the reading it stands on.
  await expect(card.getByText('Right now')).toBeVisible();
  await expect(card.getByText(`${station.name}'s charge is below 15 % for 2 min`)).toBeVisible();
  await expect(card.getByText(`${station.name}'s charge is at least 50 %`)).toBeVisible();
  await expect(card.getByText(new RegExp(`^${station.name}: Charge \\d`))).toBeVisible();
  // Once it has acted, what is switched by hand stays: until it is asked to keep things so.
  await expect(card.getByText(/what you switch by hand stays until one turns to yes again/)).toBeVisible();

  // Changed after it was made: a new name, and a look every ten minutes, kept.
  const renamed = unique('Charge window');
  await card.getByText('Edit', { exact: true }).click();
  await page.getByLabel('Name').fill(renamed);
  await page.getByRole('radio', { name: '10 min' }).click();
  await expect(page.getByText(/something switched by hand against it is switched back/)).toBeVisible();
  await press(page, 'Save changes');
  card = page.getByRole('region', { name: renamed });
  await expect(card.getByText(renamed, { exact: true })).toBeVisible();
  await expect(card.getByText(/Every 10 min it also runs again while one still holds/)).toBeVisible();
  await expect(card.getByText(/^Looks again \d/)).toBeVisible();

  // Its history: made, then changed, and what changed.
  await card.getByText('History', { exact: true }).click();
  await expect(card.getByText(/Made the automation/)).toBeVisible();
  await expect(card.getByText('Changed', { exact: true })).toBeVisible();
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
    data: { name, recipe: 'standard.charge-between', roles: { battery: { device: station.id, part: 'main' }, charger: { device: plug.id, part: 'main' } }, params: { low: 15, high: 50, minutes: 2 }, timeZone: 'Europe/Stockholm' },
  });
  expect(made.ok()).toBe(true);

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
