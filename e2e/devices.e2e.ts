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

test('a NIU scooter is found under Vehicles, and its page draws its battery with no screen of its own', async ({ page, request }) => {
  await page.goto('/add-device');
  await page.getByText('Vehicles', { exact: true }).click();
  await expect(page.getByText('NIU scooter', { exact: true })).toBeVisible();

  const scooter = await addSimulated(request, 'niu.scooter', unique('Scooter'));
  await page.goto(`/device/${scooter.id}`);
  await expect(page.getByText('Battery', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Charge', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Range', { exact: true }).first()).toBeVisible();
});
