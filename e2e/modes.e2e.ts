import { expect, test } from './fixtures';

import { press, unique } from './helpers';

/*
  Modes (docs/PLAN-WORLD-MODEL.md §8.10): a home set to away from the home
  screen, said as who set it; a family's own mode added in settings, there
  to tap beside the built-in ones.
*/

const HEADERS = { 'x-kraftverk-client': 'app' };

test('a home set to away from the home screen, by its owner; a mode of the family’s own beside the built-in ones', async ({ page, request }) => {
  await page.goto('/');
  const presence = page.getByRole('radiogroup', { name: /^Whether anyone is home, at / }).first();
  await presence.getByRole('radio', { name: 'Away' }).click();
  await expect(presence.getByRole('radio', { name: 'Away' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByText(/^Away since \d{1,2}:\d\d( [AP]M)?, set by /).first()).toBeVisible();
  const { homes } = await (await request.get('/api/homes', { headers: HEADERS })).json();
  const { modes } = await (await request.get(`/api/homes/${homes[0].id}/modes`, { headers: HEADERS })).json();
  expect(modes.find((each: { axis: string }) => each.axis === 'presence').mode.key).toBe('away');

  await page.goto('/settings/modes');
  const name = unique('Guests over');
  await page.getByRole('textbox', { name: 'A mode of your own' }).fill(name);
  await press(page, 'Add a mode');
  // Shown: in its list, and as a choice of the home's mode, as each comes.
  await expect(page.getByText(name, { exact: true }).first()).toBeVisible();
  await page.goto('/');
  await expect(page.getByRole('radiogroup', { name: /^Whether anyone is home, at / }).first().getByRole('radio', { name })).toBeVisible();
  // Home again, as it was: no other test finds the home away.
  const back = await request.put(`/api/homes/${homes[0].id}/modes`, { headers: HEADERS, data: { mode: 'home' } });
  expect(back.ok()).toBe(true);
});
