import { expect, test } from '@playwright/test';

import { addSimulated, press, unique } from './helpers';

const HEADERS = { 'x-kraftverk-client': 'app' };

/*
  An account, and the devices reached through it (docs/PLAN-INTEGRATIONS.md
  §4.3), as a person meets them: a NIU account — simulated, its two scooters
  charging and riding by themselves — finds its scooters; one is added
  through it, matched to its model, and read through it. And a file kept
  before an account was a device of its own comes back with one.
*/

test('a NIU account finds its scooters: one is added through it, as its model, and read through it', async ({ page, request }) => {
  const account = await addSimulated(request, 'niu.account', unique('NIU account'));

  // Not among the devices: under its integration, on NIU's page.
  await page.goto('/integration/niu');
  await expect(page.getByText('Accounts', { exact: true })).toBeVisible();
  await press(page, account.name);
  await expect(page).toHaveURL(new RegExp(`/integration/niu/account/${account.id}`));
  // NIU's own panel, and signing in again.
  await expect(page.getByText('How NIU is asked', { exact: true })).toBeVisible();

  // Its page: what is behind it, not added yet — each as the model it says it is. A device's address for it leads here too.
  await page.goto(`/device/${account.id}`);
  await expect(page).toHaveURL(new RegExp(`/integration/niu/account/${account.id}`));
  await expect(page.getByText('Through it', { exact: true })).toBeVisible();
  await expect(page.getByText('Not added yet · NIU UQi GT')).toBeVisible();
  await expect(page.getByText('Not added yet · NIU scooter')).toBeVisible();

  // Added from there: chosen behind its account, read through it, named.
  await press(page, 'Scooter one');
  await expect(page.getByText('It answered')).toBeVisible();
  await press(page, 'Continue');
  const name = unique('Scooter one');
  await page.getByRole('textbox').first().fill(name);
  await press(page, 'Save');
  await expect(page).toHaveURL(/\/device\//);
  const id = page.url().split('/device/')[1]!.split(/[/?#]/)[0]!;

  // Read through its account, and said to be.
  const device = await (await request.get(`/api/devices/${id}`, { headers: HEADERS })).json();
  expect(device).toMatchObject({ typeId: 'niu.uqi-gt', connections: [{ transport: 'bridge', address: 'SIMULATED-NIU-1', through: { id: account.id, name: account.name } }] });
  await expect.poll(async () => (await (await request.get(`/api/devices/${id}`, { headers: HEADERS })).json()).health.detail).toContain('through its NIU account');
  await page.goto(`/device/${id}/settings`);
  await expect(page.getByText(`Through your NIU account, through ${account.name}`)).toBeVisible();

  // The account's page lists it now as one of yours.
  await page.goto(`/device/${account.id}`);
  await expect(page.getByText(name, { exact: true })).toBeVisible();
});

test('a file kept before an account was a device of its own comes back with one: the scooter reached through it', async ({ request }) => {
  // As version 4 wrote it — the scooter with its own account and password — and as the kept copy beside a database is.
  const text = [
    'kraftverk: 4',
    'devices:',
    '  kept-scooter:',
    '    type: niu.uqi-gt',
    '    name: Kept scooter',
    '    connect:',
    '      - via: cloud',
    '        settings: { account: rider@example.test, serial: N0TAREALSERIAL01 }',
    '        secrets: { password: correct horse }',
    '',
  ].join('\n');
  const plan = await (await request.post('/api/config/plan', { headers: HEADERS, data: { text } })).json();
  expect(plan.problems).toEqual([]);
  expect(plan.devices.map((item: { key: string; action: string }) => [item.key, item.action]).sort()).toEqual([
    ['kept-scooter', 'add'],
    ['niu-account', 'add'],
  ]);
});
