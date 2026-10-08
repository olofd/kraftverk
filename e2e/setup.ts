import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { request, type FullConfig } from '@playwright/test';

/**
 * A fresh server has no account: the first is created from the home network,
 * which this machine is. Made here with a password generated for this run
 * alone — kept in the run's state directory, never printed. The API the tests
 * set things up with starts signed in with it; the browser signs in itself,
 * as its owner's account (fixtures.ts).
 */
export default async function setup(config: FullConfig): Promise<void> {
  const { baseURL, storageState } = config.projects[0]!.use;
  const state = process.env.E2E_STATE_DIR!;
  const credentials = { username: 'e2e-admin', password: randomBytes(18).toString('base64url') };
  writeFileSync(join(state, 'account.json'), JSON.stringify(credentials));

  const api = await request.newContext({ baseURL, extraHTTPHeaders: { 'x-kraftverk-client': 'app' } });
  const created = await api.post('/api/auth/setup', { data: credentials });
  if (!created.ok()) throw new Error(`The first account could not be made: ${created.status()} ${await created.text()}`);
  await api.storageState({ path: storageState as string });
  await api.dispose();
}
