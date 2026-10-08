import { expect, test } from './fixtures';

import { press } from './helpers';

/*
  Where kraftverk meets each service and platform (docs/PLAN-INTEGRATIONS.md
  §1.1): every integration, where it runs and what its node must be, kept
  apart (§0) — and on its own page, the kinds of device it knows, the
  integration's generic one last.
*/

test('Integrations, from Home: each platform, where it runs, and its own page with what it knows', async ({ page }) => {
  await page.goto('/');
  await press(page, 'Integrations');
  await expect(page.getByText('Where kraftverk meets each service and platform: your accounts and gateways on it, and what it knows')).toBeVisible();

  // Each platform, and where it runs: NIU's, and apart from that, what the node holding it must be, and why.
  await expect(page.getByText('Sydpower', { exact: true })).toBeVisible();
  await expect(page.getByText(/Runs on a server and on a phone\. Held by a node that is trusted to keep it: your NIU password stays at home/)).toBeVisible();

  // Tuya's page: its products first, then the plug for one nobody has described.
  await press(page, 'Tuya');
  await expect(page.getByText('What it knows', { exact: true })).toBeVisible();
  await expect(page.getByText('ATORCH S1W', { exact: true }).last()).toBeVisible();
  await expect(page.getByText('Tuya smart plug', { exact: true }).last()).toBeVisible();
  await expect(page.getByText(/For one nobody has described yet/).last()).toBeVisible();

  // A service is the platform's own.
  await page.goto('/integrations/open-meteo');
  await expect(page.getByText(/Its service/).first()).toBeVisible();
});
