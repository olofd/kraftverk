import { expect, test } from '@playwright/test';

import { addSimulated, press, unique } from './helpers';

/*
  Zigbee through Zigbee2MQTT (docs/PLAN-ZIGBEE.md), against a simulated
  coordinator — a played Zigbee2MQTT with a plug that meters, a wall switch
  and a sensor: its page, the devices behind it offered on their shelves, a
  device let to join and offered once it has said what it is, and a plug
  added from there and switched.
*/

test('a Zigbee coordinator: its devices offered as what they are, one joining, a plug added and switched', async ({ page, request }) => {
  const coordinator = await addSimulated(request, 'zigbee2mqtt.bridge', unique('Zigbee'));
  await page.goto(`/integrations/zigbee2mqtt/gateways/${coordinator.id}`);

  // What is behind it, each on its shelf, with what it is.
  await expect(page.getByText('Pair a device', { exact: true })).toBeVisible();
  await expect(page.getByText('Through it', { exact: true })).toBeVisible();
  await expect(page.getByText(/Not added yet · Zigbee plug/).first()).toBeVisible();
  await expect(page.getByText(/Not added yet · Zigbee switch/).first()).toBeVisible();
  await expect(page.getByText(/Not added yet · Zigbee sensor/).first()).toBeVisible();

  // Let devices join: a countdown, a device joining, then offered as what it is.
  await press(page, 'Let devices join');
  await expect(page.getByText(/Letting devices join — \d:\d\d left/)).toBeVisible();
  await expect(page.getByText(/Not added yet · Zigbee light/).first()).toBeVisible({ timeout: 15_000 });
  await press(page, 'Stop');
  await expect(page.getByText('Add a new device', { exact: true })).toBeVisible();

  // The plug, added from there: checked through the coordinator, named, and switched on its own page.
  await page.getByText(/Not added yet · Zigbee plug/).first().click();
  await expect(page.getByText('It answered')).toBeVisible();
  await press(page, 'Continue');
  const name = unique('Desk plug');
  await page.getByRole('textbox').first().fill(name);
  await press(page, 'Save');
  await expect(page).toHaveURL(/\/devices\//);
  await expect(page.getByText(name, { exact: true }).filter({ visible: true }).first()).toBeVisible();
  await expect(page.getByText('42 W', { exact: true }).filter({ visible: true }).first()).toBeVisible();
});
