import { expect, test } from '@playwright/test';

import { addSimulated, link, unique } from './helpers';

/*
  Devices as their pages draw them: the station through its own screens —
  drawn from its declared readings and the house's links, asking it nothing
  of their own — and a service through the generic ones, its values current
  for as long as its attributes say.
*/

test('the station’s own dashboard and settings draw what it reports, and what feeds it', async ({ page, request }) => {
  const station = await addSimulated(request, 'aferiy.p280', unique('Garage P280'));
  const charger = await addSimulated(request, 'atorch.s1w', unique('Charger plug'));
  await link(request, { device: charger.id, part: 'main' }, { device: station.id, part: 'input.ac' });

  await page.goto(`/device/${station.id}`);
  await expect(page.getByText('Grid', { exact: true })).toBeVisible();
  await expect(page.getByText('Solar', { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/^\d+%?$/).first()).toBeVisible();
  // The light is a part it reports, with the mode it remembers; mains says what feeds it.
  await expect(page.getByText('Light', { exact: true }).first()).toBeVisible();
  await expect(page.getByText(new RegExp(`fed by ${charger.name}`))).toBeVisible();

  await page.goto(`/device/${station.id}/settings`);
  await expect(page.getByText('AC charge limit', { exact: true })).toBeVisible();
  await expect(page.getByText('Whole machine unused time', { exact: true })).toBeVisible();
});

test('a forecast fetched a while ago is still current: its card is not drawn as old', async ({ page, request }) => {
  const weather = await addSimulated(request, 'open-meteo.weather', unique('Weather'), { place: 'Home', latitude: 59.3, longitude: 18.1 });

  await page.goto('/');
  const card = page.getByRole('button', { name: new RegExp(`^${weather.name},`) });
  await expect(card).toBeVisible();
  await expect(card).toContainText('°C');
  await expect(card).not.toContainText('as of');
});

test('electricity prices: the price now in the currency chosen, and where the hour stands today', async ({ page, request }) => {
  const prices = await addSimulated(request, 'elprisetjustnu.prices', unique('Prices'), { area: 'SE3', currency: 'SEK' });

  await page.goto('/');
  const card = page.getByRole('button', { name: new RegExp(`^${prices.name},`) });
  await expect(card).toBeVisible();
  await expect(card).toContainText('SEK/kWh');

  await page.goto(`/device/${prices.id}`);
  await expect(page.getByText('Electricity price', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Price rank today', { exact: true }).first()).toBeVisible();
});

test('the device list follows the live stream: a new device appears without reloading', async ({ page, request }) => {
  // The socket, through the same origin as the app — as the web container serves it.
  const opened = page.waitForEvent('websocket', (socket) => socket.url().endsWith('/api/live'));
  await page.goto('/');
  const live = await opened;
  await expect(page.getByText('Your devices').first()).toBeVisible();

  // Said over the socket, not found by a poll: the list is read again because the stream said so.
  const said = live.waitForEvent('framereceived', (frame) => String(frame.payload).includes('"type":"changed"'));
  const plug = await addSimulated(request, 'atorch.s1w', unique('Late plug'));
  await said;
  await expect(page.getByRole('button', { name: new RegExp(`^${plug.name},`) })).toBeVisible();

  // And what it reports moves on the page as the device reports it.
  const readings = await live.waitForEvent('framereceived', (frame) => String(frame.payload).includes('"type":"readings"'));
  expect(String(readings.payload)).toContain('"readings"');
});

test('a model has its pictures, and the one shown is its owner’s pick: tap the picture, choose another', async ({ page, request }) => {
  const scooter = await addSimulated(request, 'niu.uqi-gt', unique('Scooter'));
  await page.goto(`/device/${scooter.id}`);
  await page.getByRole('button', { name: `Change the picture of ${scooter.name}` }).click();
  const dialog = page.getByRole('dialog', { name: `The picture of ${scooter.name}` });
  await expect(dialog.getByRole('radio')).toHaveCount(3);
  await expect(dialog.getByRole('radio', { name: 'Picture 1' })).toHaveAttribute('aria-checked', 'true');
  await dialog.getByRole('radio', { name: 'Picture 2' }).click();
  await expect(dialog).toHaveCount(0);

  // Kept by the server: every app shows the same.
  const device = await (await request.get(`/api/devices/${scooter.id}`, { headers: { 'x-kraftverk-client': 'app' } })).json();
  expect(device.picture).toBe('type:1');
  await page.getByRole('button', { name: `Change the picture of ${scooter.name}` }).click();
  await expect(page.getByRole('radio', { name: 'Picture 2' })).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('a Zigbee plug is offered under Smart plugs, reached through its gateway; its settings read in words', async ({ page, request }) => {
  await page.goto('/add-device');
  await page.getByText('Smart plugs', { exact: true }).click();
  await page.getByText('Tuya Zigbee plug', { exact: true }).click();
  await expect(page.getByText('Its Zigbee gateway, through your server', { exact: true })).toBeVisible();

  const plug = await addSimulated(request, 'tuya.zigbee-plug', unique('Fan plug'));
  await page.goto(`/device/${plug.id}/settings`);
  await expect(page.getByText('After a power cut', { exact: true })).toBeVisible();
  await expect(page.getByText('Indicator light', { exact: true })).toBeVisible();
  await expect(page.getByText('Button locked', { exact: true })).toBeVisible();
});

test('a NIU scooter is found under Vehicles — the common one, and a model of its own — and its page says how full it is, what it is doing and when it reported', async ({ page, request }) => {
  await page.goto('/add-device');
  await page.getByText('Vehicles', { exact: true }).click();
  await expect(page.getByText('NIU scooter', { exact: true })).toBeVisible();
  await expect(page.getByText('NIU UQi GT', { exact: true })).toBeVisible();

  // A model reported with its finish after its name is still that model: the check lets it be added as one.
  const scooter = await addSimulated(request, 'niu.uqi-gt', unique('Scooter'));
  await page.goto(`/device/${scooter.id}`);
  await expect(page.getByRole('progressbar')).toBeVisible();
  await expect(page.getByText(/^(Charging|Switched on|Parked)$/)).toBeVisible();
  await expect(page.getByText(/^Reported to NIU /)).toBeVisible();
  await expect(page.getByText('Its battery', { exact: true })).toBeVisible();
  // What NIU says for working things out is folded away, until asked for.
  await expect(page.getByText('Mobile signal', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: /More from NIU/ }).click();
  await expect(page.getByText('Mobile signal', { exact: true })).toBeVisible();

  // Its card says it in words: yes or no, not on or off.
  await page.goto('/');
  const card = page.getByRole('button', { name: new RegExp(`^${scooter.name},`) });
  await expect(card).toContainText('Range');
  await expect(card).toContainText(/Charging\s*(Yes|No)/);
});
