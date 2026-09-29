import { expect, test } from '@playwright/test';

import { addSimulated, unique } from './helpers';

/*
  Pages every device gets from its description, with no screen of its own:
  its tools drawn from their declarations, a page per part, and what devices
  said went wrong.
*/

test('a tool is drawn from its declaration and run: the plug’s datapoints, answered as its layout sends them', async ({ page, request }) => {
  const plug = await addSimulated(request, 'atorch.s1w', unique('Desk plug'));

  await page.goto(`/device/${plug.id}/settings`);
  await page.getByText('Tools', { exact: true }).last().click();
  await expect(page.getByText('Datapoints', { exact: true }).last()).toBeVisible();
  await page.getByRole('button', { name: 'Run' }).click();
  // The answer, checked against the declaration by whoever holds the plug.
  await expect(page.getByText(/"relayCandidates"/)).toBeVisible();
  await expect(page.getByText(/"relayOn": true/)).toBeVisible();
});

test('a part has a page of its own: what it reports, and its history', async ({ page, request }) => {
  const station = await addSimulated(request, 'aferiy.p280', unique('Cabin P280'));

  await page.goto(`/device/${station.id}/part/input.ac`);
  await expect(page.getByText('Mains', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Mains present', { exact: true })).toBeVisible();
  await expect(page.getByText('Mains voltage', { exact: true }).first()).toBeVisible();
  // Its history offers only what it keeps: the mains figures, not the station's charge.
  await expect(page.getByRole('radio', { name: 'Mains voltage' })).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Charge' })).toHaveCount(0);
});

test('problems across devices: a page of their own, reached from home', async ({ page }) => {
  await page.goto('/');
  await page.getByText('Problems', { exact: true }).click();
  await expect(page).toHaveURL(/\/problems$/);
  await expect(page.getByText('Warnings and errors your devices reported')).toBeVisible();
});
