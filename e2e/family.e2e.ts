import { expect, OWNER, test } from './fixtures';

import { addSimulated, unique } from './helpers';

/*
  Where everyone is (docs/PLAN-WORLD-MODEL.md §8.9, §11): a phone said to be
  carried, in its settings; the family's page then says where its carrier is,
  as far as they share — and their own page what they carry.
*/

test('a phone carried by the owner: where everyone is says where they are, and their page what they carry', async ({ page, request }) => {
  const phone = await addSimulated(request, 'icloud.device', unique('Pocket phone'));
  await page.goto(`/devices/${phone.id}/settings`);
  await page.getByRole('radiogroup', { name: 'Who carries it' }).getByRole('radio', { name: OWNER.name }).click();
  await expect(page.getByRole('radiogroup', { name: 'Who carries it' }).getByRole('radio', { name: OWNER.name })).toHaveAttribute('aria-checked', 'true');

  await page.goto('/family');
  const owner = page.getByRole('button', { name: new RegExp(`^${OWNER.name}`) });
  // Sharing which place they are at, carrying a phone: at one of the family's places, or away from them all — in words.
  await expect(owner).toContainText(/At .+ since \d\d:\d\d|Away: at none of the family’s places/);
  await owner.click();
  await expect(page.getByRole('heading', { level: 1, name: OWNER.name })).toBeVisible();
  await expect(page.getByText('shares which place they are at').first()).toBeVisible();
  await expect(page.getByText(phone.name, { exact: true }).filter({ visible: true })).toBeVisible();
});
