import { expect, test, type Page } from '@playwright/test';

import { answer, press } from './helpers';

/*
  The app with no server at all: it keeps a home of its own — in a browser,
  the hub in its worker, on SQLite in the origin's private file system — and
  holds every connection itself: the same device code, the same gateway, the
  same automations. How someone tries kraftverk before installing anything.
*/

test.use({ storageState: { cookies: [], origins: [] } });

/** Replaces what a YAML editor holds, as if typed. */
async function write(page: Page, label: string, text: string) {
  const editor = page.getByRole('textbox', { name: label });
  await editor.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.insertText(text);
}

test('without a server, the app keeps its own home: a simulated plug added, switched through its own gateway, and an automation run', async ({ page }) => {
  await page.goto('/');
  await press(page, 'Use without a server');

  await page.goto('/devices/add');
  await press(page, 'Smart plugs');
  await press(page, 'Tuya smart plug');
  await press(page, 'Simulated');
  await expect(page.getByText('It answered')).toBeVisible();
  await press(page, 'Continue');
  await page.getByRole('textbox').first().fill('Desk plug');
  await press(page, 'Save');

  await expect(page.getByText('240 W', { exact: true }).filter({ visible: true }).first()).toBeVisible();
  const power = page.getByRole('switch').first();
  await expect(power).toHaveAttribute('aria-checked', 'true');

  // The same rule as on a server: off while it carries a load is confirmed.
  await power.click();
  expect(await answer(page, true)).toContain('Power is 240 W');
  await expect(power).toHaveAttribute('aria-checked', 'false');

  // Automations, with no server: one written as YAML, made, and run from its page.
  await page.goto('/automations');
  await page.getByRole('button', { name: 'New automation' }).click();
  await page.getByText('As YAML', { exact: true }).click();
  await write(page, 'New automation, as configuration', ['name: Desk plug back on', 'mode: watch', 'clock: Europe/Stockholm', 'uses:', '  plug: desk-plug', 'do:', '  - turn on: plug', ''].join('\n'));
  await expect(page.getByText('Ready', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Create' }).click();
  const main = page.getByRole('main');
  await expect(page.getByRole('heading', { level: 1, name: 'Desk plug back on' })).toBeVisible();
  // The gateway gives a part five seconds between a person's switches, here as on a server: waited out, not got round.
  await page.waitForTimeout(5_500);
  await main.getByRole('button', { name: 'Start Desk plug back on' }).click();
  expect(await answer(page, true)).toContain('started by you it acts');
  await expect(main.getByRole('status').first()).toHaveText(/^Turned Desk plug on · Just now$/, { timeout: 20_000 });
  // It acted, through the same gateway: its run says so, and the plug is on again.
  const activity = page.getByRole('region', { name: 'Activity' });
  await expect(activity.getByText('Turn Desk plug on').first()).toBeVisible();

  // Kept, not held in memory: opened again, the home is as it was left — the plug, on.
  await page.goto('/');
  await page.getByRole('button', { name: /^Desk plug/ }).click();
  await expect(page.getByRole('switch').first()).toHaveAttribute('aria-checked', 'true');
});
