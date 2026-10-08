import { expect, test } from './fixtures';

import { pick, press, unique } from './helpers';

/*
  Automating people and places (docs/PLAN-WORLD-MODEL-WORK.md W7): "when the
  last one leaves, set away" made from its recipe, nothing to choose; and
  "tell when someone comes home", its people chosen — everyone — each said
  as the family's words.
*/

test('away when everyone leaves, from its recipe: nothing to choose, its triggers said as people; telling everyone when someone comes home', async ({ page }) => {
  await page.goto('/automations');
  await page.getByRole('button', { name: 'New automation' }).click();
  await press(page, 'Away when everyone leaves');
  await expect(page.getByRole('status')).toContainText('It can run as it is');
  const name = unique('Away when everyone leaves');
  await page.getByLabel('Name').fill(name);
  await press(page, 'Create');
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
  const when = page.getByRole('region', { name: 'When' });
  await expect(when.getByText('When the last of the family leaves home', { exact: false }).first()).toBeVisible();
  await expect(when.getByText('When the first of the family arrives home', { exact: false }).first()).toBeVisible();
  // Right now: whether anyone is home, as presence says.
  await expect(page.getByRole('region', { name: 'Right now' }).getByText(/the family/).first()).toBeVisible();

  await page.goto('/automations');
  await page.getByRole('button', { name: 'New automation' }).click();
  await press(page, 'Tell when someone comes home');
  await expect(page.getByRole('region', { name: 'Uses' }).getByText('Who is told: choose who')).toBeVisible();
  await pick(page, 'Who is told', 'Everyone in the family');
  await expect(page.getByRole('status')).toContainText('It can run as it is');
  const told = unique('Tell when someone comes home');
  await page.getByLabel('Name').fill(told);
  await press(page, 'Create');
  await expect(page.getByRole('heading', { level: 1, name: told })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Does' }).getByText('Tell everyone: “{who came or went} is home”', { exact: true })).toBeVisible();
});
