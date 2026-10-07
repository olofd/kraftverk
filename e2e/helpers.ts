import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, request as playwrightRequest, type APIRequestContext, type Page } from '@playwright/test';

/**
 * What the tests do more than once. Devices are added through the Simulated
 * method, so the real server holds them as it holds any device — setup,
 * sessions, the gateway, history, the live stream and automations all run —
 * and only the hardware is not there. Each test names its devices so they do
 * not meet another test's in the one database.
 */

const HEADERS = { 'x-kraftverk-client': 'app' };

export type Added = { id: string; name: string };

/**
 * Adds a simulated device straight through the API: for what a test needs to
 * exist, not what it tests. `simulation`: what its simulated world is set up
 * with — how fast it runs (`speed`), and its type's own choices (a station's
 * `level` to start from).
 */
export async function addSimulated(request: APIRequestContext, typeId: string, name: string, device?: Record<string, unknown>, simulation?: Record<string, unknown>): Promise<Added> {
  const call = async (path: string, method: 'POST' | 'PATCH', data?: unknown) => {
    const response = await request.fetch(`/api${path}`, { method, headers: HEADERS, data });
    expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBe(true);
    return response.json();
  };
  const draft = await call('/setup', 'POST', { typeId, methodId: 'simulated' });
  if (device) await call(`/setup/${draft.id}`, 'PATCH', { device });
  if (simulation) await call(`/setup/${draft.id}`, 'PATCH', { connection: simulation });
  await call(`/setup/${draft.id}/check`, 'POST');
  const saved = await call(`/setup/${draft.id}/save`, 'POST', { name });
  return { id: saved.id, name: saved.name };
}

/**
 * The second server, whose home's clock runs fast (playwright.config.ts),
 * signed in: its first account made by the first test to ask, with a password
 * made for this run alone and kept in its state directory; any later test
 * signs in with it. What it says over the API, in the time it keeps.
 */
export async function fastServer(): Promise<{ api: APIRequestContext; rate: number }> {
  const api = await playwrightRequest.newContext({ baseURL: process.env.E2E_FAST_API!, extraHTTPHeaders: HEADERS });
  const kept = join(process.env.E2E_STATE_DIR!, 'fast-account.json');
  if (!existsSync(kept)) {
    const credentials = { username: 'e2e-fast', password: randomBytes(18).toString('base64url') };
    writeFileSync(kept, JSON.stringify(credentials));
    const made = await api.post('/api/auth/setup', { data: credentials });
    expect(made.ok(), `the fast server's first account: ${await made.text()}`).toBe(true);
  } else {
    const signed = await api.post('/api/auth/login', { data: JSON.parse(readFileSync(kept, 'utf8')) });
    expect(signed.ok(), `signing in to the fast server: ${await signed.text()}`).toBe(true);
  }
  return { api, rate: Number(process.env.E2E_FAST_CLOCK_RATE) };
}

/** Records that one part feeds another. */
export async function link(request: APIRequestContext, source: { device: string; part: string }, target: { device: string; part: string }): Promise<void> {
  const response = await request.post('/api/links', { headers: HEADERS, data: { kind: 'feeds', source, target } });
  expect(response.ok(), await response.text()).toBe(true);
}

/** A name no other test uses. */
export const unique = (name: string) => `${name} ${Math.random().toString(36).slice(2, 6)}`;

/** "Garage P280 k2fa’s", "Garage P280 k2fs’": whose, as the app says it — a name that ends in s takes only the mark. */
export const whose = (name: string) => (name.endsWith('s') ? `${name}’` : `${name}’s`);

/**
 * The app's own question, answered: what it says, then yes or no. The app asks
 * in a dialog of its own, not the browser's `confirm` — which some browsers
 * answer no to at once, showing nothing.
 */
export async function answer(page: Page, yes: boolean): Promise<string> {
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  const said = await dialog.innerText();
  const buttons = dialog.getByRole('button');
  await (yes ? buttons.last() : dialog.getByRole('button', { name: 'Cancel' })).click();
  await expect(dialog).toHaveCount(0);
  return said;
}

/**
 * Presses the row, card or option whose text is exactly this — of what is
 * shown: a page gone back from stays in the stack, hidden, with its own.
 */
export const press = (page: Page, text: string) => page.getByText(text, { exact: true }).filter({ visible: true }).first().click();
