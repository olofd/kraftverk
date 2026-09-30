import { expect, test } from '@playwright/test';

import { addSimulated, answer, press, unique } from './helpers';

/*
  A sequence you start (docs/SEQUENCES.md): the owner's charging chain — a
  station's AC output powering a Zigbee plug a scooter's charger is in. Made
  from the shared recipe, shown as its steps, tried while it only watches,
  started once it acts, followed as it goes, and started again from the
  plug's own page.
*/

test('start charging: made from its recipe, shown as steps, tried, let act, started — and startable from a device it is about', async ({ page, request }) => {
  const station = await addSimulated(request, 'aferiy.p280', unique('Garage P280'));
  const plug = await addSimulated(request, 'tuya.zigbee-plug', unique('Scooter plug'));

  await page.goto('/automations');
  await press(page, 'New automation');
  // A sequence says what it is: it takes steps, and you start it.
  await expect(page.getByText('Steps', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('You start it', { exact: true }).first()).toBeVisible();
  await press(page, 'Start charging');
  // What it will do, before anything is chosen.
  await expect(page.getByText('What it will do')).toBeVisible();
  await expect(page.getByText('Wait until the charger’s plug can be reached — at most 2 min')).toBeVisible();

  // Each role lists every part that can fill it: the supply's list first, then the charger's.
  await page.getByText(`${station.name} — AC outlets`, { exact: true }).first().click();
  await page.getByText(plug.name, { exact: true }).last().click();
  const name = unique('Charge the scooter');
  await page.getByLabel('Name').fill(name);
  await press(page, 'Create');

  const card = page.getByRole('region', { name });
  await expect(card.getByText('What it does')).toBeVisible();
  await expect(card.getByText(`Turn ${station.name} — AC outlets on`)).toBeVisible();
  await expect(card.getByText(/If a step does not succeed, or you stop it/i)).toBeVisible();

  // Only watching: tried, it says what it would do, and switches nothing.
  await card.getByRole('button', { name: `Try ${name}` }).click();
  await expect(card.getByText('If it were started now')).toBeVisible();

  // Let act — confirmed — and started.
  await card.getByRole('radio', { name: 'Act' }).click();
  await answer(page, true);
  await card.getByRole('button', { name: `Start ${name}` }).click();
  // It runs, and ends: the last run, each step as it went.
  await expect(card.getByText(/^Last run/)).toBeVisible({ timeout: 20_000 });
  await expect(card.getByText(`Turn ${plug.name} on`).first()).toBeVisible();
  await expect(card.getByText(/^At once — /).first()).toBeVisible();

  // Its history: the run, started by its owner.
  await card.getByText('History', { exact: true }).click();
  await expect(card.getByText(/^by e2e-admin/).first()).toBeVisible();

  // The plug's page offers it, to start from there.
  await page.goto(`/device/${plug.id}`);
  await expect(page.getByText('Start', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: `Start ${name}` })).toBeVisible();
});
