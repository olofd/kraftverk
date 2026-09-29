import { expect, test } from '@playwright/test';

import { addSimulated, press, unique } from './helpers';

/*
  Adding a device, as a person does it: the shelves, the way to reach it,
  the check, and — beside a device it fits — what it is linked to, part by
  part.
*/

test('the add screen lists its shelves under devices and services, naming what each holds', async ({ page }) => {
  await page.goto('/add-device');
  await expect(page.getByText('Devices', { exact: true })).toBeVisible();
  await expect(page.getByText('Services', { exact: true })).toBeVisible();
  await expect(page.getByText('Power stations', { exact: true })).toBeVisible();
  // Each shelf says which products it holds, not prose about one of them.
  await expect(page.getByText('ATORCH S1W, Tuya smart plug')).toBeVisible();
  await expect(page.getByText('Open-Meteo', { exact: true })).toBeVisible();
});

test('a plug added beside a station is asked what it feeds, and the answer is a part: the station’s mains input', async ({ page, request }) => {
  const station = await addSimulated(request, 'aferiy.p280', unique('Garage P280'));
  const plugName = unique('Charger plug');

  await page.goto('/add-device');
  await press(page, 'Smart plugs');
  await press(page, 'ATORCH S1W');
  await press(page, 'Simulated, through your server');
  await expect(page.getByText('It answered')).toBeVisible();
  await press(page, 'Continue');

  await page.getByRole('textbox').first().fill(plugName);
  await expect(page.getByText('What is plugged into this?', { exact: false })).toBeVisible();
  await press(page, `${station.name} — Mains`);
  await press(page, 'Save');

  // Its page, and on its settings the fact it records about the house.
  await expect(page).toHaveURL(/\/device\//);
  await page.goto(`${page.url()}/settings`);
  await expect(page.getByText(`It feeds ${station.name} — Mains`)).toBeVisible();
});
