import { ALONE, expect, test, type Page } from './fixtures';

import { unique } from './helpers';

/*
  Scripts in the app (docs/PLAN-SCRIPTS.md): one written, read as it is
  typed by the home's own engine — the server's, or this browser's when it
  keeps a home of its own — which says what it declares, or what is wrong
  with it, at its line; kept, found among the family's scripts, changed;
  and, with a server, in the configuration file.
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
