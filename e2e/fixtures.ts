import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { test as base, devices, expect, type BrowserContext, type Locator, type Page } from '@playwright/test';

/*
  Who a test's browser is, set up once and kept (docs/PLAN-WORLD-MODEL.md
  §10.6). The app opens on an account of this device — kept in the
  browser's own storage, which no cookie or storage state carries — so each
  person the tests act as is a browser profile of their own, signed up the
  way a person does it the first time it is asked for, and reused by every
  test after: one sign-up a run, not one a test.

  How a profile gets ready is a list of the screens the app can stand on,
  each with what a person does there (`STEPS`). A screen added in front of
  the app, or changed, is one entry here; no test changes.
*/

/** Someone the tests act as: an account on a device of their own, and where its family is. */
export type Person = {
  /** Their profile's name, and what their device is called. */
  key: string;
  name: string;
  /** The family on the run's server, signed in to with its first login; or one kept on this device alone. */
  family: 'server' | 'this device';
};

/** The run's owner: the server's first login, claimed by their account. Every test is them unless it says otherwise. */
export const OWNER: Person = { key: 'owner', name: 'Olive Owner', family: 'server' };
/** Someone with no server at all: the app keeps their family itself. */
export const ALONE: Person = { key: 'alone', name: 'Alex Alone', family: 'this device' };

/** The server's first login, made by the global setup with a password of this run's own. */
const serverLogin = (): { username: string; password: string } => JSON.parse(readFileSync(join(process.env.E2E_STATE_DIR!, 'account.json'), 'utf8'));

/** What onboarding learns as it goes: the recovery words, shown once and asked for next. */
type Onboarding = { person: Person; words: string[] };

/** A screen the app may stand on before it is ready, and what a person does there. */
type Step = { name: string; on: (page: Page) => Locator; act: (page: Page, onboarding: Onboarding) => Promise<void> };

const press = (page: Page, text: string) => page.getByText(text, { exact: true }).filter({ visible: true }).first().click();

const STEPS: Step[] = [
  {
    name: 'welcome',
    on: (page) => page.getByText('Create a local account', { exact: true }),
    act: async (page, { person }) => {
      await press(page, 'Create a local account');
      await page.getByRole('textbox', { name: 'Your name' }).fill(person.name);
      await page.getByRole('textbox', { name: 'What this device is called' }).fill(`${person.name}’s browser`);
      await press(page, 'Continue');
    },
  },
  {
    name: 'recovery words',
    on: (page) => page.getByRole('list', { name: 'Your twelve recovery words, in order' }),
    act: async (page, onboarding) => {
      const items = await page.getByRole('list', { name: 'Your twelve recovery words, in order' }).getByRole('listitem').allInnerTexts();
      onboarding.words = items.map((item) => item.trim().split(/\s+/).at(-1)!);
      await press(page, 'I have written them down');
    },
  },
  {
    name: 'recovery check',
    on: (page) => page.getByText('Check your words', { exact: true }),
    act: async (page, { words }) => {
      for (const field of await page.getByRole('textbox', { name: /^Word \d+$/ }).all()) {
        const index = Number((await field.getAttribute('aria-label'))!.slice('Word '.length)) - 1;
        await field.fill(words[index]!);
      }
      await press(page, 'Done');
    },
  },
  {
    name: 'server sign-in',
    on: (page) => page.getByRole('textbox', { name: 'Username' }),
    act: async (page, { person }) => {
      if (person.family === 'this device') return press(page, 'Use without a server');
      const { username, password } = serverLogin();
      await page.getByRole('textbox', { name: 'Username' }).fill(username);
      await page.getByRole('textbox', { name: 'Password' }).fill(password);
      await page.getByRole('textbox', { name: 'Password' }).press('Enter');
    },
  },
  {
    name: 'found a family',
    on: (page) => page.getByRole('textbox', { name: 'What you call it' }),
    act: async (page, { person }) => {
      await page.getByRole('textbox', { name: 'What you call it' }).fill(`${person.name}’s family`);
      await press(page, 'Continue');
    },
  },
  {
    name: 'where the first home is',
    on: (page) => page.getByText('Skip for now', { exact: true }),
    act: (page) => press(page, 'Skip for now'),
  },
];

/** Ready: a screen of the app itself. */
const ready = (page: Page) => page.getByRole('main').filter({ visible: true });

/** Walks the app from wherever it opens to a screen of its own, doing each step's part on the way; each step at most twice. */
async function onboard(page: Page, person: Person): Promise<void> {
  const onboarding: Onboarding = { person, words: [] };
  const done = new Map<string, number>();
  await page.goto('/');
  for (;;) {
    const anyScreen = STEPS.reduce((all, step) => all.or(step.on(page)), ready(page));
    const known = await anyScreen
      .filter({ visible: true })
      .first()
      .waitFor({ timeout: 15_000 })
      .then(() => true, () => false);
    if (!known) {
      // Said as the app says it: what it is still waiting for, by its spinner's name.
      const waits = await page.getByRole('progressbar').evaluateAll((spinners) => spinners.map((spinner) => spinner.getAttribute('aria-label')).filter(Boolean));
      throw new Error(`Setting up ${person.key}: no screen the setup knows (e2e/fixtures.ts STEPS)${waits.length ? `; the app is still ${waits.join(', ').toLowerCase()}` : ''}`);
    }
    if (await ready(page).first().isVisible()) return;
    const step = await (async () => {
      for (const each of STEPS) if (await each.on(page).filter({ visible: true }).first().isVisible()) return each;
      return null;
    })();
    if (!step) continue;
    const times = (done.get(step.name) ?? 0) + 1;
    if (times > 2) throw new Error(`Setting up ${person.key}: stuck at "${step.name}"`);
    done.set(step.name, times);
    await step.act(page, onboarding);
    await expect(step.on(page).filter({ visible: true })).toHaveCount(0, { timeout: 10_000 }).catch(() => undefined);
  }
}

/** Each person's browser profile, opened once a worker and set up the first time a test asks. */
class Profiles {
  readonly #open = new Map<string, Promise<BrowserContext>>();
  constructor(private readonly launch: (dir: string) => Promise<BrowserContext>) {}

  as(person: Person): Promise<BrowserContext> {
    let context = this.#open.get(person.key);
    if (!context) {
      context = (async () => {
        const dir = join(process.env.E2E_STATE_DIR!, 'profiles', person.key);
        mkdirSync(dir, { recursive: true });
        const opened = await this.launch(dir);
        const page = await opened.newPage();
        await onboard(page, person);
        await page.close();
        return opened;
      })();
      this.#open.set(person.key, context);
    }
    return context;
  }

  async close(): Promise<void> {
    for (const context of this.#open.values()) await (await context).close().catch(() => undefined);
  }
}

const { defaultBrowserType: _browser, ...desktop } = devices['Desktop Chrome'];

/**
 * The tests' own `test`: `page` is a new tab in the profile of whoever the
 * test is — `OWNER` unless it says `test.use({ as: ALONE })` — signed up,
 * signed in and ready. Its trace and screenshot are the config's, as for any page.
 */
export const test = base.extend<{ as: Person }, { profiles: Profiles }>({
  as: [OWNER, { option: true }],
  profiles: [
    async ({ playwright, headless }, use) => {
      const profiles = new Profiles((dir) => playwright.chromium.launchPersistentContext(dir, { ...desktop, headless, baseURL: process.env.E2E_WEB_URL }));
      await use(profiles);
      await profiles.close();
    },
    { scope: 'worker' },
  ],
  // Signing up the first time is a run's, not a test's: timed on its own.
  context: [async ({ as, profiles }, use) => use(await profiles.as(as)), { scope: 'test', timeout: 60_000 }],
  page: async ({ context }, use) => {
    const page = await context.newPage();
    await use(page);
    await page.close();
  },
});

export { expect };
export type { APIRequestContext, Page } from '@playwright/test';
