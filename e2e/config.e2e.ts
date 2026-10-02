import { expect, test, type Page } from '@playwright/test';

import { addSimulated, answer, unique } from './helpers';

/*
  Configuration in the app (docs/CONFIG.md): a device exported from its
  settings, removed, and imported again from that file — read first, then
  brought back with its history under the same key; an automation shown as
  its YAML, and changed by writing it so, checked as it is typed; an import
  that names a device you do not have, given one of yours; and the same
  screens on a phone.
*/

const HEADERS = { 'x-kraftverk-client': 'app' };

/** What a YAML editor holds, as text. */
const textOf = (page: Page, label: string) => page.getByRole('textbox', { name: label }).evaluate((content) => (content as HTMLElement).innerText);

/** Replaces what a YAML editor holds, as if typed. */
async function write(page: Page, label: string, text: string) {
  const editor = page.getByRole('textbox', { name: label });
  await editor.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.insertText(text);
}

test('a device exported from its settings, removed, and imported again: back under its key, with its history', async ({ page, request }) => {
  const plug = await addSimulated(request, 'tuya.zigbee-plug', unique('Cellar plug'));
  const key = (await (await request.get(`/api/devices/${plug.id}`, { headers: HEADERS })).json()).key as string;

  // Its settings: its key, what it is as configuration, and an export of it alone.
  await page.goto(`/device/${plug.id}/settings`);
  await expect(page.getByLabel('Name in configuration')).toHaveValue(key);
  await page.getByRole('button', { name: 'Show as configuration' }).click();
  const own = await textOf(page, `${plug.name}, as configuration`);
  expect(own).toContain(`type: tuya.zigbee-plug\nname: ${plug.name}`);
  // Exported where it is: a file of just it.
  await page.getByRole('button', { name: 'Export' }).click();
  await page.getByRole('button', { name: 'Make the file' }).click();
  await page.getByRole('button', { name: 'Show it' }).click();
  const exported = await textOf(page, `${plug.name}, exported`);
  expect(exported).toContain(`devices:\n  ${key}:\n    type: tuya.zigbee-plug`);
  expect(exported).not.toContain('automations:');

  // Removed — then imported again from its own file, as adding a device offers.
  expect((await request.delete(`/api/devices/${plug.id}`, { headers: HEADERS })).ok()).toBe(true);
  await page.goto('/add-device');
  await page.getByText('From a configuration', { exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Import' })).toBeVisible();
  await write(page, 'The configuration to import', exported);
  await page.getByRole('button', { name: 'Read it' }).click();
  await expect(page.getByText(/^brought back, with its history/)).toBeVisible();
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(page.getByText('1 device brought back, with its history.')).toBeVisible();
  const back = (await (await request.get('/api/devices', { headers: HEADERS })).json()).devices.find((device: { key: string }) => device.key === key);
  expect(back?.id).toBe(plug.id);
});

test('an automation as YAML: shown on its page, written so, checked as it is typed, and saved as the form saves it', async ({ page, request }) => {
  const plug = await addSimulated(request, 'atorch.s1w', unique('Heater plug'));
  const plugKey = (await (await request.get(`/api/devices/${plug.id}`, { headers: HEADERS })).json()).key as string;
  const name = unique('Heater on');
  const made = await request.post('/api/automations', {
    headers: HEADERS,
    data: {
      name,
      rule: {
        roles: { plug: { label: 'Plug', description: 'Plug', capabilities: ['switch'] } },
        params: { fields: {} },
        when: [{ at: { value: '07:00' }, days: ['mon', 'tue', 'wed', 'thu', 'fri'] }],
        then: [{ command: { role: 'plug', capability: 'switch', command: 'set', args: { on: { value: true } } } }],
      },
      roles: { plug: { device: plug.id, part: 'main' } },
      starts: {},
      timeZone: 'Europe/Stockholm',
    },
  });
  expect(made.ok(), await made.text()).toBe(true);
  const automation = await made.json();

  // Rarely needed beside Run and Edit: under ⋯, a page of its own — the menu's first item has the focus.
  await page.goto(`/automation/${automation.id}`);
  await page.getByRole('button', { name: 'More' }).click();
  await expect(page.getByRole('menu').getByRole('button').first()).toBeFocused();
  await page.getByRole('button', { name: 'As configuration' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'As configuration' })).toBeVisible();
  const config = page.getByRole('region', { name: 'Configuration' });
  await config.getByRole('button', { name: 'Show as configuration' }).click();
  const shown = await textOf(page, `${name}, as configuration`);
  expect(shown).toContain(`plug: ${plugKey}`);
  expect(shown).toContain('days: weekdays');

  // Written as YAML instead: a key naming nothing is said where it is, and nothing can be saved.
  await config.getByRole('button', { name: 'Edit as YAML' }).click();
  await expect(page.getByRole('radio', { name: 'YAML' })).toBeChecked();
  const label = `${name}, as configuration`;
  const text = await textOf(page, label);
  await write(page, label, text.replace(`plug: ${plugKey}`, 'plug: no-such-plug'));
  await expect(page.getByText('Line 5, column 9: There is no device "no-such-plug", in the file or on the server')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save changes' })).toBeDisabled();

  // Right again, at another time: saved, and its page says so.
  await write(page, label, text.replace('"07:00"', '"06:30"'));
  await expect(page.getByText('Ready', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('region', { name: 'When' }).getByText('At 06:30 on weekdays')).toBeVisible();

  // Its key, changed in place.
  await page.goto(`/automation/${automation.id}/configuration`);
  await page.getByLabel('Name in configuration').fill('heater-morning');
  await config.getByRole('button', { name: 'Save' }).click();
  await expect(config.getByText('heater-morning', { exact: true })).toBeVisible();
  expect((await (await request.get(`/api/automations/${automation.id}`, { headers: HEADERS })).json()).key).toBe('heater-morning');
});

test('an import naming a device you do not have: one of yours, chosen, fills it — and letting it act is asked first', async ({ page, request }) => {
  const plug = await addSimulated(request, 'atorch.s1w', unique('Porch plug'));
  const key = unique('porch-light').replace(' ', '-');
  await page.goto('/configuration');
  await write(
    page,
    'The configuration to import',
    `kraftverk: 1\nautomations:\n  ${key}:\n    name: Porch light\n    mode: act\n    clock: Europe/Stockholm\n    uses:\n      plug: attic-plug\n    when:\n      - at: "21:00"\n    do:\n      - turn on: plug\n`
  );
  await page.getByRole('button', { name: 'Read it' }).click();
  await expect(page.getByText('Plug — it names “attic-plug”')).toBeVisible();
  await expect(page.getByText('It still needs 1 device.')).toBeVisible();
  await page.getByRole('button', { name: /^Plug: .*Choose$/ }).click();
  await page.getByText(plug.name, { exact: true }).last().click();
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  expect(await answer(page, true)).toContain('"Porch light" will act on its own');
  await expect(page.getByText('1 automation added.')).toBeVisible();
  const imported = (await (await request.get('/api/automations', { headers: HEADERS })).json()).automations.find((each: { key: string }) => each.key === key);
  expect(imported.mode).toBe('act');
  expect(imported.roles.plug.device).toBe(plug.id);
});

test('one device\'s own YAML imported as it is; an automation exported from its page and pasted into a new one written as YAML', async ({ page, request }) => {
  // A device, as its page shows it: no file around it, its key made from its name.
  const name = unique('Attic plug');
  const key = name.toLowerCase().replace(/ /g, '-');
  await page.goto('/configuration?import=1');
  await write(page, 'The configuration to import', `type: atorch.s1w\nname: ${name}\nconnect:\n  - via: simulated\n`);
  await page.getByRole('button', { name: 'Read it' }).click();
  await expect(page.getByText(`Read as one device, known by "${key}"`)).toBeVisible();
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(page.getByText('1 device added.')).toBeVisible();
  const plug = (await (await request.get('/api/devices', { headers: HEADERS })).json()).devices.find((device: { key: string }) => device.key === key);
  expect(plug?.name).toBe(name);
  await expect.poll(async () => (await (await request.get(`/api/devices/${plug.id}`, { headers: HEADERS })).json()).health.status).toBe('connected');

  // An automation built here, exported from its page...
  const made = await request.post('/api/automations', {
    headers: HEADERS,
    data: {
      name: unique('Attic on'),
      rule: { roles: { plug: { label: 'Plug', description: 'Plug', capabilities: ['switch'] } }, params: { fields: {} }, when: [{ at: { value: '08:15' } }], then: [{ command: { role: 'plug', capability: 'switch', command: 'set', args: { on: { value: true } } } }] },
      roles: { plug: { device: plug.id, part: 'main' } },
      starts: {},
      timeZone: 'Europe/Stockholm',
    },
  });
  expect(made.ok(), await made.text()).toBe(true);
  const original = await made.json();
  await page.goto(`/automation/${original.id}/configuration`);
  const config = page.getByRole('region', { name: 'Configuration' });
  await config.getByRole('button', { name: 'Export' }).click();
  await config.getByRole('button', { name: 'Make the file' }).click();
  await config.getByRole('button', { name: 'Show it' }).click();
  const file = await textOf(page, `${original.name}, exported`);
  expect(file).toContain(`automations:\n  ${original.key}:`);

  // ...and pasted, under another key, into a new automation written as YAML: made as it says.
  await page.goto('/automations');
  await page.getByRole('button', { name: 'New automation' }).click();
  await page.getByText('As YAML', { exact: true }).click();
  await expect(page.getByRole('radio', { name: 'YAML' })).toBeChecked();
  await write(page, 'New automation, as configuration', file.replace(`  ${original.key}:`, '  attic-copy:').replace('08:15', '09:45'));
  await expect(page.getByText('Ready', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('region', { name: 'When' }).getByText(/at 09:45/)).toBeVisible();
  const copy = (await (await request.get('/api/automations', { headers: HEADERS })).json()).automations.find((each: { key: string }) => each.key === 'attic-copy');
  expect(copy?.roles.plug.device).toBe(plug.id);
});
