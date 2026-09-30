import { expect, test } from '@playwright/test';

import { addSimulated, answer, link, unique } from './helpers';

/*
  What makes a command consequential is declared — by the capability, and by
  the links from the part — and the person is asked, told why, before
  anything is sent. Saying no sends nothing.
*/

test('cutting a plug that feeds a station is confirmed first, naming the part it reaches; no sends nothing', async ({ page, request }) => {
  const station = await addSimulated(request, 'aferiy.p280', unique('Garage P280'));
  const plug = await addSimulated(request, 'atorch.s1w', unique('ATORCH'));
  await link(request, { device: plug.id, part: 'main' }, { device: station.id, part: 'input.ac' });

  await page.goto(`/device/${plug.id}`);
  const power = page.getByRole('switch').first();
  await expect(power).toHaveAttribute('aria-checked', 'true');

  // Answered by a handler set before the click: a dialog that opens while the click is still settling blocks the page,
  // and a test that waits for the click before answering waits for itself.
  await power.click();
  expect(await answer(page, false)).toContain(`This feeds ${station.name} — Mains and has never been switched from here: confirm it is the right one`);

  // Not confirmed: nothing was sent, and it is still on.
  await expect(page.getByText('Not confirmed')).toBeVisible();
  await expect(power).toHaveAttribute('aria-checked', 'true');
});

test('turning off a plug that carries a load says how much, and once confirmed, it is off', async ({ page, request }) => {
  const plug = await addSimulated(request, 'atorch.s1w', unique('Heater plug'));

  await page.goto(`/device/${plug.id}`);
  const power = page.getByRole('switch').first();
  await expect(power).toHaveAttribute('aria-checked', 'true');

  await power.click();
  // As switch.set declares it: off, while it draws more than 5 W.
  expect(await answer(page, true)).toContain('Power is 240 W');
  await expect(power).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByLabel('Drawing 0 W')).toBeVisible();
});

test('a switch is operated from the keyboard: Tab to it, Space asks the same question a tap does', async ({ page, request }) => {
  const plug = await addSimulated(request, 'atorch.s1w', unique('Kettle plug'));

  await page.goto(`/device/${plug.id}`);
  const power = page.getByRole('switch').first();
  await expect(power).toHaveAttribute('aria-checked', 'true');
  await power.focus();
  await expect(power).toBeFocused();

  await page.keyboard.press('Space');
  // The question takes the keyboard: its yes is where Enter lands.
  await expect(page.getByRole('alertdialog')).toContainText('Power is 240 W');
  await page.keyboard.press('Enter');
  await expect(power).toHaveAttribute('aria-checked', 'false');
});

test('how much is a load is the home’s to say: set in App settings, the same plug turns off without asking', async ({ page, request }) => {
  const plug = await addSimulated(request, 'atorch.s1w', unique('Night light'));
  try {
    await page.goto('/app-settings');
    const load = page.getByLabel('A load worth confirming');
    await load.fill('500');
    await load.press('Enter');
    await expect
      .poll(async () => ((await (await request.get('/api/policy')).json()) as { name: string; value: number }[]).find((item) => item.name === 'loadWatts')?.value)
      .toBe(500);

    await page.goto(`/device/${plug.id}`);
    const power = page.getByRole('switch').first();
    await expect(power).toHaveAttribute('aria-checked', 'true');
    await power.click();
    await expect(power).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
  } finally {
    await request.put('/api/policy/loadWatts', { data: { value: null } });
  }
});
