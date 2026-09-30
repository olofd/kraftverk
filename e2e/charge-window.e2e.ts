import { expect, test } from '@playwright/test';

import { addSimulated, link, press, unique } from './helpers';

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
  // Named after its recipe when not named, and read back as what it does — and when it runs.
  await expect(page.getByText(`Charge ${station.name} with ${plug.name}: on when it stays below 15 % for 2 min, off when it reaches 50 %.`)).toBeVisible();
  await expect(page.getByText(`When ${station.name}'s charge is below 15 % for 2 min`)).toBeVisible();
  await expect(page.getByText('Only watching').last()).toBeVisible();

  // Changed after it was made: a new name, kept.
  const renamed = unique('Charge window');
  await page.getByText('Edit', { exact: true }).last().click();
  await page.getByLabel('Name').fill(renamed);
  await press(page, 'Save changes');
  await expect(page.getByText(renamed, { exact: true })).toBeVisible();

  // Its history: made, then changed.
  await page.getByText('History', { exact: true }).last().click();
  await expect(page.getByText(/Made the automation/).last()).toBeVisible();
  await expect(page.getByText(new RegExp(`Changed: "${renamed}"`)).last()).toBeVisible();

  // Checked now: the station's charge, and each edge it waits for, in words.
  await page.getByText('What would it do now?').last().click();
  const said = page.getByText(/^Right now,/).last();
  await expect(said).toContainText(`${station.name}'s charge is below 15 %:`);
  await expect(said).toContainText(`${station.name}'s charge is at least 50 %:`);
  await expect(said).toContainText(/Would turn .* (on|off)|Would /);

  // Rehearsed on the last week: this server has kept almost none of it, and says what it could.
  await page.getByText('Rehearse on last week').last().click();
  await expect(page.getByText(/^On the last week:/).last()).toBeVisible();
});
