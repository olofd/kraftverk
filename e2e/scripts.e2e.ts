import { ALONE, expect, test, type Page } from './fixtures';

import { answer, press, unique } from './helpers';

/*
  Scripts in the app (docs/PLAN-SCRIPTS.md): one written, read as it is
  typed by the home's own engine — the server's, or this browser's when it
  keeps a home of its own — which says what it declares, or what is wrong
  with it, at its line; kept, found among the family's scripts, changed;
  and, with a server, in the configuration file. And run: a script an
  automation runs turns a simulated plug off, through the gateway, as the
  automation — what it did said beneath its step.
*/

const LABEL = 'The script';

/** Replaces what the script's editor holds, as if typed. */
async function write(page: Page, text: string) {
  const editor = page.getByRole('textbox', { name: LABEL });
  await editor.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.insertText(text);
}

const SCRIPT = [
  "import { step, fn, t } from 'kraftverk';",
  '',
  "export const warmUp = step({ inputs: { target: t.number({ unit: '°C', min: 5, max: 30 }) }, answer: t.flag() }, async () => true);",
  'export const double = fn({ args: [t.number()], returns: t.number() }, (n: number) => n * 2);',
  '',
].join('\n');

/** A script written, read as it is typed, and kept under `name`: back on the page it is kept as. */
async function writeAndKeep(page: Page, name: string) {
  await page.goto('/automations');
  await page.getByRole('button', { name: 'Write a script' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'New script' })).toBeVisible();
  // The starter is read as it opens.
  const declared = page.getByRole('region', { name: 'What it declares' });
  await expect(declared.getByLabel('Step Tidy up')).toBeVisible();

  await write(page, SCRIPT);
  await expect(declared.getByLabel('Step Warm up').getByText('Answer — yes or no')).toBeVisible();
  await expect(declared.getByLabel('Step Warm up').getByText('Target — °C, from 5, to 30')).toBeVisible();
  await expect(declared.getByLabel('Function Double')).toBeVisible();

  // A mistake, at its line: what it declares waits until it reads again, and it cannot be kept.
  await write(page, `${SCRIPT}export const broken = ;\n`);
  await expect(page.getByText('Line 5, column 23: Unexpected token')).toBeVisible();
  await expect(declared).toBeHidden();
  await page.getByLabel('Its name').fill(name);
  await expect(page.getByRole('button', { name: 'Keep it' })).toBeDisabled();

  await write(page, SCRIPT);
  await expect(page.getByText('Ready', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Keep it' }).click();
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
}

/** Found among the family's scripts, opened, changed and saved. */
async function changeIt(page: Page, name: string) {
  await page.goto('/automations');
  const scripts = page.getByRole('region', { name: 'Scripts' });
  await expect(scripts.getByRole('link', { name }).getByText('1 step · 1 function')).toBeVisible();
  await scripts.getByRole('link', { name }).click();
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
  await write(page, SCRIPT.replace('n * 2', 'n * 3').replace(/^export const warmUp.*\n/m, ''));
  await expect(page.getByRole('region', { name: 'What it declares' }).getByLabel('Step Warm up')).toBeHidden();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(scripts.getByRole('link', { name }).getByText('0 steps · 1 function')).toBeVisible();
}

test('a script written, read as it is typed by the server, kept, changed — and in the configuration file', async ({ page, request }) => {
  const name = unique('Warm up');
  await writeAndKeep(page, name);
  await changeIt(page, name);
  const file = await request.post('/api/config/export', { headers: { 'x-kraftverk-client': 'app' }, data: { secrets: 'none' } });
  expect(((await file.json()) as { text: string }).text).toContain(`name: ${name}\n    source: |\n      import { step, fn, t } from 'kraftverk';`);
});

test.describe('with no server', () => {
  test.use({ as: ALONE });

  test('a script written, read as it is typed by this browser’s own engine, kept and changed', async ({ page }) => {
    const name = unique('Warm up');
    await writeAndKeep(page, name);
    await changeIt(page, name);
  });
});

/** A simulated plug added in the app, by name: on, drawing 240 W. */
async function addPlug(page: Page, name: string) {
  await page.goto('/devices/add');
  await press(page, 'Smart plugs');
  await press(page, 'Tuya smart plug');
  await press(page, 'Simulated');
  await expect(page.getByText('It answered')).toBeVisible();
  await press(page, 'Continue');
  await page.getByRole('textbox').first().fill(name);
  await press(page, 'Save');
  await expect(page.getByText('240 W', { exact: true }).filter({ visible: true }).first()).toBeVisible();
}

/** A script kept, and an automation that runs it, started: the plug it names turned off, and the run saying so. */
async function runIt(page: Page) {
  const plug = unique('Desk plug');
  await addPlug(page, plug);

  const name = unique('Plug off');
  await page.goto('/scripts/new');
  await page.getByLabel('Its name').fill(name);
  await write(page, [
    "import { step, home, log } from 'kraftverk';",
    '',
    'export const off = step({}, async () => {',
    `  const plug = Object.values(home.devices).find((device) => device.name === '${plug}');`,
    "  if (!plug) throw new Error('No such plug');",
    '  await plug.switch.set({ on: false });',
    "  log('Turned the plug off');",
    '});',
    '',
  ].join('\n'));
  await expect(page.getByText('Ready', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Keep it' }).click();
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
  const key = (await page.getByText(/ · written in TypeScript$/).innerText()).split(' · ')[0]!;

  // An automation that runs it, written as YAML, and started.
  const automation = unique('Evening tidy');
  await page.goto('/automations/new');
  await page.getByText('As YAML', { exact: true }).click();
  const yaml = page.getByRole('textbox', { name: 'New automation, as configuration' });
  await yaml.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.insertText([`name: ${automation}`, 'mode: watch', 'clock: Europe/Stockholm', 'uses:', `  tidy: { script: ${key} }`, 'do:', '  - run script: tidy', ''].join('\n'));
  await expect(page.getByText('Ready', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Create' }).click();
  const main = page.getByRole('main');
  await expect(page.getByRole('heading', { level: 1, name: automation })).toBeVisible();
  await main.getByRole('button', { name: `Start ${automation}` }).click();
  expect(await answer(page, true)).toContain('started by you it acts');
  // Its run: the script's step, and beneath it what the script did.
  const activity = page.getByRole('region', { name: 'Activity' });
  await expect(activity.getByText(`Run “${name}”`).first()).toBeVisible();
  await activity.getByText(`Run “${name}”`).first().click();
  await expect(page.getByText(`${plug}: switch.set on false`).first()).toBeVisible();
  await expect(page.getByText('Turned the plug off').first()).toBeVisible();
}

test('a script run by an automation turns a plug off, through the gateway, as the automation', async ({ page }) => {
  await runIt(page);
});

test.describe('run with no server', () => {
  test.use({ as: ALONE });

  test('a script run by an automation, in this browser’s own home, turns a plug off', async ({ page }) => {
    await runIt(page);
  });
});
