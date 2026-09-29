import { expect, test } from '@playwright/test';

import { addSimulated, unique } from './helpers';

/*
  Devices as their pages draw them: the station through its own screens —
  which read its declared state tool, answers checked — and a service through
  the generic ones, its values current for as long as its attributes say.
*/

test('the station’s own dashboard and settings draw what it reports', async ({ page, request }) => {
  const station = await addSimulated(request, 'aferiy.p280', unique('Garage P280'));

  await page.goto(`/device/${station.id}`);
  await expect(page.getByText('Grid', { exact: true })).toBeVisible();
  await expect(page.getByText('Solar', { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/^\d+%?$/).first()).toBeVisible();

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
