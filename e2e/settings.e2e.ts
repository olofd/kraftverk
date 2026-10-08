import { expect, test } from './fixtures';

import { addSimulated, answer, unique } from './helpers';

/*
  A setting is changed as a person means it: once, whether the slider was
  dragged or moved from the keyboard.
*/

test('where the home is: typed in degrees, said back with today’s sunrise and sunset, and forgotten', async ({ page, request }) => {
  // On the home's own page: each home has its place.
  const { homes } = await (await request.get('/api/homes', { headers: { 'x-kraftverk-client': 'app' } })).json();
  await page.goto(`/settings/homes/${homes[0].id}`);
  // Made-up coordinates: Greenwich.
  await page.getByLabel('Latitude', { exact: true }).fill('51,4779');
  await page.getByLabel('Longitude', { exact: true }).fill('0');
  await page.getByRole('button', { name: /^(Save|Move it here)$/ }).click();
  await expect(page.getByText('51.48° N, 0.00° E', { exact: true })).toBeVisible();
  await expect(page.getByText(/^Today the sun rises at \d\d:\d\d and sets at \d\d:\d\d, on its clock\.$/)).toBeVisible();
  await page.getByRole('button', { name: 'Forget it' }).click();
  await expect(page.getByText('Not said yet', { exact: true })).toBeVisible();
});

test('a slider moved from the keyboard is written once, when the keys stop', async ({ page, request }) => {
  const plug = await addSimulated(request, 'atorch.s1w', unique('Desk plug'));
  const reading = async () => {
    const device = await (await request.get(`/api/devices/${plug.id}`, { headers: { 'x-kraftverk-client': 'app' } })).json();
    return (device.readings as { key: string; value: unknown }[]).find((r) => r.key === 'brightness')?.value;
  };
  expect(await reading()).toBe(6);

  await page.goto(`/devices/${plug.id}/settings`);
  const thumb = page.getByRole('slider', { name: 'Brightness', exact: true });
  await thumb.focus();
  // Arrow keys move the value with no slide around them: two presses, one write.
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');

  await expect.poll(reading).toBe(8);
  const audit = await (await request.get(`/api/audit?resourceKind=device&resource=${encodeURIComponent(plug.id)}`, { headers: { 'x-kraftverk-client': 'app' } })).json();
  const writes = (audit as { kind: string }[]).filter((entry) => entry.kind === 'settings.intent');
  expect(writes).toHaveLength(1);
  // And the row follows the device again: nothing refused, nothing left dragging.
  await expect(page.getByText(/Too soon/)).toHaveCount(0);
});

test('a button that cannot be undone asks first, in the server’s words; no runs nothing, yes runs it once', async ({ page, request }) => {
  const plug = await addSimulated(request, 'atorch.s1w', unique('Desk plug'));
  const ran = async () => {
    const audit = await (await request.get(`/api/audit?resourceKind=device&resource=${encodeURIComponent(plug.id)}`, { headers: { 'x-kraftverk-client': 'app' } })).json();
    return (audit as { kind: string }[]).filter((entry) => entry.kind === 'device.tool').length;
  };

  await page.goto(`/devices/${plug.id}/settings`);
  const reset = page.getByRole('button', { name: 'Reset', exact: true });

  await reset.click();
  expect(await answer(page, false)).toContain('cannot be brought back');
  await expect(page.getByText('Not confirmed')).toBeVisible();
  expect(await ran()).toBe(0);

  await reset.click();
  await answer(page, true);
  await expect.poll(ran).toBe(1);
});

test('what you share of where you are: chosen on People, kept, paused for an hour, and shared again', async ({ page }) => {
  await page.goto('/settings/people');
  const choice = page.getByRole('radiogroup', { name: 'What the family sees of where you are' });
  await choice.getByRole('radio', { name: 'Only whether I’m home' }).click();
  await expect(page.getByText('The family sees only whether you are at one of its homes.')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('radiogroup', { name: 'What the family sees of where you are' }).getByRole('radio', { name: 'Only whether I’m home' })).toHaveAttribute('aria-checked', 'true');
  // Your own row says it, as the others see it.
  await expect(page.getByText(/shares only whether they are home/).first()).toBeVisible();

  await page.getByRole('button', { name: 'Pause for an hour' }).click();
  await expect(page.getByText(/^Paused: the family sees nothing of where you are until/)).toBeVisible();
  await page.getByRole('button', { name: 'Share again' }).click();
  await expect(page.getByRole('button', { name: 'Pause for an hour' })).toBeVisible();
  // Back as it was, for the tests after.
  await page.getByRole('radiogroup', { name: 'What the family sees of where you are' }).getByRole('radio', { name: 'Which place I’m at' }).click();
  await expect(page.getByText(/shares which place they are at/).first()).toBeVisible();
});

test('a zone: added in degrees, listed, renamed on its own page, and let go', async ({ page }) => {
  const name = unique('School');
  await page.goto('/settings/zones');
  // Made-up coordinates near Greenwich.
  await page.getByRole('textbox', { name: 'Its name' }).fill(name);
  await page.getByRole('textbox', { name: 'Latitude' }).fill('51,49');
  await page.getByRole('textbox', { name: 'Longitude' }).fill('0.01');
  await page.getByRole('button', { name: 'Add it' }).click();
  await page.getByText(name, { exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
  await expect(page.getByText('51.49° N, 0.01° E · 200 m across its middle').filter({ visible: true }).first()).toBeVisible();

  const renamed = `${name} yard`;
  await page.getByRole('textbox', { name: 'Its name' }).fill(renamed);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('heading', { level: 1, name: renamed })).toBeVisible();

  await page.getByRole('button', { name: 'Let it go' }).click();
  await answer(page, true);
  await expect(page.getByRole('heading', { level: 1, name: 'Zones' })).toBeVisible();
  await expect(page.getByText(renamed, { exact: true })).toHaveCount(0);
});
