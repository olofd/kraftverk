import { expect, test } from '@playwright/test';

import { addSimulated, answer, unique } from './helpers';

/*
  A setting is changed as a person means it: once, whether the slider was
  dragged or moved from the keyboard.
*/

test('where the home is: typed in degrees, said back with today’s sunrise and sunset, and forgotten', async ({ page }) => {
  await page.goto('/settings');
  // Made-up coordinates: Greenwich.
  await page.getByLabel('Latitude', { exact: true }).fill('51,4779');
  await page.getByLabel('Longitude', { exact: true }).fill('0');
  await page.getByRole('button', { name: /^(Save|Move it here)$/ }).click();
  await expect(page.getByText('51.48° N, 0.00° E', { exact: true })).toBeVisible();
  await expect(page.getByText(/^Today the sun rises at \d\d:\d\d and sets at \d\d:\d\d\.$/)).toBeVisible();
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
