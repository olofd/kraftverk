import { expect, OWNER, PLAIN, test } from './fixtures';

import { press } from './helpers';

/*
  The app on a page a browser does not trust — plain HTTP by a name, as
  http://kraftverk.local is on a home network. The browser keeps no account
  there, so the app is its server's: signed in with a password, as the
  person that login is, and saying why nothing is kept in it.
*/

test.use({ as: PLAIN });

test('on plain HTTP the app is its server’s: signed in with a password, as yourself, and says why it keeps no account', async ({ page }) => {
  expect(await page.evaluate(() => window.isSecureContext)).toBe(false);

  // The family on the server, as on any page.
  await page.goto('/settings');
  await expect(page.getByText(/This page is plain HTTP, so this browser keeps no account here/)).toBeVisible();
  // No way to join with an invitation here: that takes an account this page cannot keep.
  await expect(page.getByText('Join a family', { exact: true })).toHaveCount(0);

  // Who you are: the person the login is.
  await page.goto('/settings/people');
  await expect(page.getByText(`${OWNER.name} (you)`, { exact: true })).toBeVisible();

  // Signed out, the way back is the password — and there is no "without a server" on a page that keeps nothing.
  await page.goto('/settings/accounts');
  await press(page, 'Sign out');
  await expect(page.getByRole('textbox', { name: 'Username' })).toBeVisible();
  await expect(page.getByText('Use without a server', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Without a server, on a secure page', { exact: true })).toBeVisible();
});
