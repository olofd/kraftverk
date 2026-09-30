import { expect, test } from '@playwright/test';

import { answer, press } from './helpers';

/*
  The app with no server at all: it keeps its own devices and holds every
  connection itself — the same device code, the same gateway, in the browser.
  How someone tries kraftverk before installing anything.
*/

test.use({ storageState: { cookies: [], origins: [] } });

test('without a server, the app adds a simulated plug and switches it itself, through its own gateway', async ({ page }) => {
  await page.goto('/');
  await press(page, 'Use without a server');

  await page.goto('/add-device');
  await press(page, 'Smart plugs');
  await press(page, 'Tuya smart plug');
  await press(page, 'Simulated, from this browser');
  await expect(page.getByText('It answered')).toBeVisible();
  await press(page, 'Continue');
  await page.getByRole('textbox').first().fill('Desk plug');
  await press(page, 'Save');

  await expect(page.getByText('240 W', { exact: true }).first()).toBeVisible();
  const power = page.getByRole('switch').first();
  await expect(power).toHaveAttribute('aria-checked', 'true');

  // The same rule as on a server: off while it carries a load is confirmed.
  await power.click();
  expect(await answer(page, true)).toContain('Power is 240 W');
  await expect(power).toHaveAttribute('aria-checked', 'false');
});
