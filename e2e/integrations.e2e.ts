import { expect, test } from '@playwright/test';

import { press } from './helpers';

/*
  What this kraftverk can reach, by platform (docs/PLAN-INTEGRATIONS.md §1):
  each integration with where it runs and what its node must be, kept apart
  (§0), and the products known on it — the platform's generic one last.
*/

test('App settings → Integrations: each platform, where it runs, and the products on it', async ({ page }) => {
  await page.goto('/app-settings');
  await press(page, 'Integrations');
  await expect(page.getByText('The platforms kraftverk reaches, and the products it knows on each')).toBeVisible();

  // A platform with no type of its own: its product, and where that runs.
  await expect(page.getByText('Sydpower', { exact: true })).toBeVisible();
  await expect(page.getByText('AFERIY P280', { exact: true })).toBeVisible();
  // Tuya: its products first, then the plug for one nobody has described.
  const tuya = page.getByText('Tuya', { exact: true });
  await expect(tuya).toBeVisible();
  await expect(page.getByText('ATORCH S1W', { exact: true })).toBeVisible();
  await expect(page.getByText(/Tuya smart plug/).first()).toBeVisible();
  await expect(page.getByText(/For one nobody has described yet/).first()).toBeVisible();
  // NIU: where it runs, and apart from that, what the node holding it must be, and why.
  await expect(page.getByText(/Runs on a server, in a browser and on a phone\. Held by a node that is trusted to keep it: your NIU password stays at home/)).toBeVisible();
  // A service is the platform's own.
  await expect(page.getByText(/Its service/).first()).toBeVisible();

  await page.screenshot({ path: 'test-results/integrations-page.png', fullPage: true });
});
