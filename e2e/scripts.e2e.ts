import { ALONE, expect, test, type Page } from './fixtures';

/*
  Scripts in the app (docs/PLAN-SCRIPTS.md): one written, read as it is
  typed by the home's own engine — the server's, or this browser's when it
  keeps a home of its own — which says what it declares, or what is wrong
  with it, at its line.
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

async function readAsTyped(page: Page) {
  await page.goto('/automations');
  await page.getByRole('button', { name: 'Write one' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'New script' })).toBeVisible();
  // The starter is read as it opens.
  const declared = page.getByRole('region', { name: 'What it declares' });
  await expect(declared.getByLabel('Step Tidy up')).toBeVisible();

  await write(page, SCRIPT);
  await expect(declared.getByLabel('Step Warm up').getByText('Answer — yes or no')).toBeVisible();
  await expect(declared.getByLabel('Step Warm up').getByText('Target — °C, from 5, to 30')).toBeVisible();
  await expect(declared.getByLabel('Function Double')).toBeVisible();

  // A mistake, at its line; what it declares waits until it reads again.
  await write(page, `${SCRIPT}export const broken = ;\n`);
  await expect(page.getByText('Line 5, column 23: Unexpected token')).toBeVisible();
  await expect(declared).toBeHidden();
}

test('a script, read as it is typed by the server: what it declares, and a mistake at its line', async ({ page }) => {
  await readAsTyped(page);
});

test.describe('with no server', () => {
  test.use({ as: ALONE });

  test('a script, read as it is typed by this browser’s own engine', async ({ page }) => {
    await readAsTyped(page);
  });
});
