import { expect, type APIRequestContext, type Page } from '@playwright/test';

/**
 * What the tests do more than once. Devices are added through the Simulated
 * method, so the real server holds them as it holds any device — setup,
 * sessions, the gateway, history, the live stream and automations all run —
 * and only the hardware is not there. Each test names its devices so they do
 * not meet another test's in the one database.
 */

const HEADERS = { 'x-kraftverk-client': 'app' };

export type Added = { id: string; name: string };

/** Adds a simulated device straight through the API: for what a test needs to exist, not what it tests. */
export async function addSimulated(request: APIRequestContext, typeId: string, name: string, device?: Record<string, unknown>): Promise<Added> {
  const call = async (path: string, method: 'POST' | 'PATCH', data?: unknown) => {
    const response = await request.fetch(`/api${path}`, { method, headers: HEADERS, data });
    expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBe(true);
    return response.json();
  };
  const draft = await call('/setup', 'POST', { typeId, methodId: 'simulated' });
  if (device) await call(`/setup/${draft.id}`, 'PATCH', { device });
  await call(`/setup/${draft.id}/check`, 'POST');
  const saved = await call(`/setup/${draft.id}/save`, 'POST', { name });
  return { id: saved.id, name: saved.name };
}

/** Records that one part feeds another. */
export async function link(request: APIRequestContext, source: { device: string; part: string }, target: { device: string; part: string }): Promise<void> {
  const response = await request.post('/api/links', { headers: HEADERS, data: { kind: 'feeds', source, target } });
  expect(response.ok(), await response.text()).toBe(true);
}

/** A name no other test uses. */
export const unique = (name: string) => `${name} ${Math.random().toString(36).slice(2, 6)}`;

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

/** Presses the row, card or option whose text is exactly this. */
export const press = (page: Page, text: string) => page.getByText(text, { exact: true }).first().click();
