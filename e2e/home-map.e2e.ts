import { expect, test, type APIRequestContext } from './fixtures';

import { addSimulated, press, unique } from './helpers';

/*
  A home's map (docs/PLAN-WORLD-MODEL.md §8.5, §8.7, §8.9): a floor and a
  bathroom made, a simulated Zigbee sensor placed in it — someone walks in as
  it starts — so the map says someone is in the bathroom, by that sensor.
  Then the bathroom traced by tapping its corners: its outline kept, in
  metres in its frame. Made-up places near Greenwich.
*/

const HEADERS = { 'x-kraftverk-client': 'app' };

async function api<T>(request: APIRequestContext, method: 'GET' | 'POST' | 'PATCH' | 'PUT', path: string, data?: unknown): Promise<T> {
  const response = await request.fetch(`/api${path}`, { method, headers: HEADERS, data });
  expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBe(true);
  return (await response.json()) as T;
}

type Space = { id: string; kind: string; name: string; outline: [number, number][] | null };

test('a home’s map: the bathroom someone is in, said by its sensor; the bathroom traced, its outline kept', async ({ page, request }) => {
  const { homes } = await api<{ homes: { id: string; location: unknown }[] }>(request, 'GET', '/homes');
  const home = homes[0]!;
  if (!home.location) await api(request, 'PATCH', `/homes/${home.id}`, { location: { latitude: 51.4779, longitude: 0, radius: 150 } });
  const { spaces } = await api<{ spaces: Space[] }>(request, 'GET', `/homes/${home.id}/spaces`);
  const site = spaces.find((space) => space.kind === 'site')!;
  const floor = await api<Space>(request, 'POST', '/spaces', { parentId: site.id, kind: 'floor', name: unique('Floor'), level: 7 });
  const bathroom = await api<Space>(request, 'POST', '/spaces', { parentId: floor.id, kind: 'room', purpose: 'bathroom', name: unique('Bathroom') });
  const sensor = await addSimulated(request, 'zigbee2mqtt.sensor', unique('Bathroom sensor'));
  await api(request, 'PUT', `/devices/${sensor.id}/placement`, { placement: { spaceId: bathroom.id } });

  await page.goto(`/rooms/${home.id}`);
  await expect(page.getByRole('img', { name: /, its rooms/ })).toBeVisible();
  await expect(page.locator('[data-ready="true"]')).toBeAttached();
  // A home with other floors asks which: this one.
  const floors = page.getByRole('radiogroup', { name: 'Floor' });
  if (await floors.count()) await floors.getByRole('radio', { name: floor.name }).click();
  // Someone came in as the sensor started: the bathroom has someone in it, said by the sensor.
  const someone = page.getByRole('region', { name: 'Someone is in' });
  await expect(someone.getByText(new RegExp(`Since \\d{1,2}:\\d\\d( [AP]M)?, said by ${sensor.name}`))).toBeVisible();
  await expect(someone.getByText(bathroom.name, { exact: true })).toBeVisible();

  // Traced: four corners tapped on the map, then kept.
  await page.getByRole('radiogroup', { name: 'Trace a room' }).getByRole('radio', { name: bathroom.name }).click();
  await expect(page.getByText(`Tap each corner of ${bathroom.name} in turn — 0 so far`)).toBeVisible();
  const map = page.getByRole('img', { name: new RegExp(`: ${floor.name}, its rooms`) });
  await expect(map.locator('[data-ready="true"]')).toBeAttached();
  const box = (await map.boundingBox())!;
  for (const [x, y] of [
    [0.3, 0.3],
    [0.7, 0.3],
    [0.7, 0.7],
    [0.3, 0.7],
  ] as const)
    await map.click({ position: { x: box.width * x, y: box.height * y } });
  await expect(page.getByText(`Tap each corner of ${bathroom.name} in turn — 4 so far`)).toBeVisible();
  await press(page, 'Keep it');
  await expect(page.getByRole('radio', { name: `${bathroom.name} again` })).toBeVisible();
  const kept = (await api<{ spaces: Space[] }>(request, 'GET', `/homes/${home.id}/spaces`)).spaces.find((space) => space.id === bathroom.id)!;
  expect(kept.outline).toHaveLength(4);
  // A square on the screen is a rectangle of metres: its sides apart, its corners in order.
  const [a, b, c] = kept.outline!;
  expect(Math.abs(b![0] - a![0])).toBeGreaterThan(1);
  expect(Math.abs(c![1] - b![1])).toBeGreaterThan(1);
});
