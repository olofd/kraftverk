import { expect, test } from '@playwright/test';

import { addSimulated, unique } from './helpers';

/*
  A setting is changed as a person means it: once, whether the slider was
  dragged or moved from the keyboard.
*/

test('a slider moved from the keyboard is written once, when the keys stop', async ({ page, request }) => {
  const plug = await addSimulated(request, 'atorch.s1w', unique('Desk plug'));
  const reading = async () => {
    const device = await (await request.get(`/api/devices/${plug.id}`, { headers: { 'x-kraftverk-client': 'app' } })).json();
    return (device.readings as { key: string; value: unknown }[]).find((r) => r.key === 'brightness')?.value;
  };
  expect(await reading()).toBe(6);

  await page.goto(`/device/${plug.id}/settings`);
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
