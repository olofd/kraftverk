import { ALONE, expect, test, type Page } from './fixtures';

import { answer, press, unique } from './helpers';

/*
  Scripts in the app (docs/PLAN-SCRIPTS.md): one written, read as it is
  typed by the home's own engine — the server's, or this browser's when it
  keeps a home of its own — which says what it declares, or what is wrong
  with it, at its line; kept, found among the family's scripts, changed;
  and, with a server, in the configuration file. And run: a script an
  automation runs turns a simulated plug off, through the gateway, as the
  automation — what it did said beneath its step; and a step tried from the
  editor, as the person, the gateway's yes asked for and given.
*/

const LABEL = 'The script';

/** Replaces what the script's editor holds, as if typed. */
async function write(page: Page, text: string) {
  const editor = page.getByRole('textbox', { name: LABEL });
  await editor.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.insertText(text);
}

const WARM_UP = [
  '/** Warms a room up to a temperature. */',
  'export async function warmUp(',
  '  /** @min 5 @max 30 */',
  '  target: Celsius,',
  '): Promise<boolean> {',
  '  return target > 0;',
  '}',
  '',
].join('\n');

const DOUBLE = ['export function double(n: number): number {', '  return n * 2;', '}', ''].join('\n');

const SCRIPT = ["import type { Celsius } from 'kraftverk';", '', WARM_UP, DOUBLE].join('\n');

/** A device's name as a script writes it: "Desk plug k2fa" is `deskPlugK2fa`. */
const scriptName = (name: string) => name.split(/[^A-Za-z0-9]+/).map((word, at) => (at ? word.charAt(0).toUpperCase() + word.slice(1) : word.toLowerCase())).join('');

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
  await expect(declared.getByLabel('Step Warm up').getByText('Target — °C, from 5 °C, to 30 °C')).toBeVisible();
  await expect(declared.getByLabel('Step Warm up').getByText('Warms a room up to a temperature.')).toBeVisible();
  await expect(declared.getByLabel('Function Double')).toBeVisible();

  // A mistake, at its line: what it declares waits until it reads again, and it cannot be kept.
  await write(page, `${SCRIPT}export const broken = ;\n`);
  await expect(page.getByText('Line 14, column 23: Unexpected token')).toBeVisible();
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
  await write(page, DOUBLE.replace('n * 2', 'n * 3'));
  await expect(page.getByRole('region', { name: 'What it declares' }).getByLabel('Step Warm up')).toBeHidden();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(scripts.getByRole('link', { name }).getByText('0 steps · 1 function')).toBeVisible();
}

test('a script written, read as it is typed by the server, kept, changed — and in the configuration file', async ({ page, request }) => {
  const name = unique('Warm up');
  await writeAndKeep(page, name);
  await changeIt(page, name);
  const file = await request.post('/api/config/export', { headers: { 'x-kraftverk-client': 'app' }, data: { secrets: 'none' } });
  expect(((await file.json()) as { text: string }).text).toContain(`name: ${name}\n    source: |\n      export function double(n: number): number {\n        return n * 3;`);
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
    "import { devices, log } from 'kraftverk';",
    '',
    'export async function off(): Promise<void> {',
    `  await devices.${scriptName(plug)}.turnOff();`,
    "  log('Turned the plug off');",
    '}',
    '',
  ].join('\n'));
  await expect(page.getByText('Ready', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Keep it' }).click();
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
  const key = (await page.getByText(/ · written in TypeScript$/).innerText()).split(' · ')[0]!;

  // An automation that runs it, written as YAML — the script by its key where the step runs it, no role to write — and started.
  const automation = unique('Evening tidy');
  await page.goto('/automations/new');
  await page.getByText('As YAML', { exact: true }).click();
  const yaml = page.getByRole('textbox', { name: 'New automation, as configuration' });
  await yaml.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.insertText([`name: ${automation}`, 'mode: watch', 'clock: Europe/Stockholm', 'do:', `  - run script: ${key}.off`, ''].join('\n'));
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

test('the editor knows the home: a device’s name completes as it is typed, a mistake of types is marked and said, and a step is run from it', async ({ page }) => {
  const plug = unique('Desk plug');
  await addPlug(page, plug);
  await page.goto('/scripts/new');
  // TypeScript, in its worker: a parameter's type is what it is given, and a mistake with it is said where it is.
  await write(page, ['export async function go(level: number): Promise<void> {', '  const said: string = level;', '}', ''].join('\n'));
  await expect(page.getByText("Line 2, column 9: Type 'number' is not assignable to type 'string'.")).toBeVisible();
  // And it offers this home's devices by name, asked for as the name is begun.
  await write(page, ["import { devices } from 'kraftverk';", '', 'export async function off(): Promise<void> {', '  await devices.'].join('\n'));
  await page.keyboard.press('Control+Space');
  const completions = page.locator('.cm-tooltip-autocomplete');
  await expect(completions.getByText(scriptName(plug), { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');

  // Run from here, as written: through the gateway, which asks a yes first where the home counts its load as one to ask
  // for (other tests change that line; the hub's own test holds the yes) — given when asked, it is off.
  await write(page, ["import { devices } from 'kraftverk';", '', 'export async function off(): Promise<void> {', `  await devices.${scriptName(plug)}.turnOff();`, '}', ''].join('\n'));
  const step = page.getByRole('region', { name: 'What it declares' }).getByLabel('Step Off');
  await step.getByRole('button', { name: 'Run Off now' }).click();
  const asked = step.getByText(/^It needs your yes/);
  const done = step.getByText('Done', { exact: true });
  await expect(asked.or(done)).toBeVisible();
  if (await asked.isVisible()) await step.getByRole('button', { name: 'Yes — run it again' }).click();
  await expect(done).toBeVisible();
  await expect(step.getByText(`${plug}: switch.set on false`)).toBeVisible();
});

test('a script’s step, run when… — an automation made from it in the form, started: its own words in the run, its default given', async ({ page }) => {
  const name = unique('Hello');
  await page.goto('/scripts/new');
  await page.getByLabel('Its name').fill(name);
  await write(page, ["import { log, type Duration } from 'kraftverk';", '', '/** Says it ran. */', 'export async function hello(', '  /** @default 2 min */', '  after: Duration,', '): Promise<string> {', '  log(`Hello after ${after} s`);', "  return 'Said hello';", '}', ''].join('\n'));
  await expect(page.getByText('Ready', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Keep it' }).click();
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();

  // Run it when…: the form, its step in it, its input's default said — when it runs still to choose.
  await page.getByRole('button', { name: 'Run Hello when…' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'New automation' })).toBeVisible();
  await page.getByText(`Run ${name} (hello)`).click();
  await expect(page.getByText('Not given: it takes 2 min.')).toBeVisible();
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();

  const main = page.getByRole('main');
  await main.getByRole('button', { name: `Start ${name}` }).click();
  expect(await answer(page, true)).toContain('started by you it acts');
  const activity = page.getByRole('region', { name: 'Activity' });
  await expect(activity.getByText(`Ran “${name}” (hello)`).first()).toBeVisible();
  await activity.getByText(`Ran “${name}” (hello)`).first().click();
  await expect(page.getByText('Hello after 120 s').first()).toBeVisible();
});

test.describe('run with no server', () => {
  test.use({ as: ALONE });

  test('a script run by an automation, in this browser’s own home, turns a plug off', async ({ page }) => {
    await runIt(page);
  });
});
