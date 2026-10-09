import { expect, test } from './fixtures';

import { press, unique } from './helpers';

/*
  A home's variables (docs/PLAN-VARIABLES-AND-TRIGGERS.md V1): a counter
  declared in settings, its key shown as an automation reads it; counted on
  the home screen, and set from elsewhere — the card reads it again as the
  home says it changed.
*/

const HEADERS = { 'x-kraftverk-client': 'app' };

test('a counter declared in settings, counted on the home screen, and set from elsewhere: the card follows', async ({ page, request }) => {
  await page.goto('/settings/variables');
  const title = unique('Dryer runs');
  await page.getByRole('textbox', { name: "A variable's title" }).first().fill(title);
  await page.getByRole('radiogroup', { name: 'What it holds' }).first().getByRole('radio', { name: 'A counter' }).click();
  // Its key made from its title, as an automation reads it.
  const said = page.getByText(/^In automations: home\.var\.dryerRuns\w+$/).first();
  await expect(said).toBeVisible();
  const key = (await said.textContent())!.replace('In automations: home.var.', '');
  await press(page, 'Add a variable');
  await expect(page.getByText(title, { exact: true }).first()).toBeVisible();

  await page.goto('/');
  await page.getByRole('button', { name: `${title}: one more` }).click();
  await page.getByRole('button', { name: `${title}: one more` }).click();
  const { homes } = await (await request.get('/api/homes', { headers: HEADERS })).json();
  await expect
    .poll(async () => (await (await request.get(`/api/homes/${homes[0].id}/variables`, { headers: HEADERS })).json()).variables.find((each: { key: string }) => each.key === key)?.value)
    .toBe(2);

  // Set from elsewhere — another phone, a script — the card reads it again.
  const set = await request.put(`/api/homes/${homes[0].id}/variables/${key}`, { headers: HEADERS, data: { value: 7 } });
  expect(set.ok()).toBe(true);
  await expect(page.getByText('7', { exact: true }).first()).toBeVisible();

  // Let go: no other test finds it.
  const removed = await request.delete(`/api/variables/${(await set.json()).id}`, { headers: HEADERS });
  expect(removed.ok()).toBe(true);
});
