import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { defineConfig, devices } from '@playwright/test';

/**
 * The app, end to end: the web build against a kraftverk server of its own,
 * with a database of its own, every device simulated. What a person sees and
 * does — adding a device, linking parts, making an automation, a confirmation
 * — rather than what a route returns, which the server's own tests cover.
 *
 * The server is read-only: nothing it runs can reach real hardware, and the
 * simulated devices take writes either way. `npm run test:e2e` builds the app
 * first (e2e/run.mjs).
 */

const ROOT = resolve(import.meta.dirname, '..');
/**
 * Which of the shards run side by side this is (e2e/run.mjs --shards): each
 * its own ports, servers and results. 0 when it runs alone.
 */
const SHARD = Number(process.env.E2E_SHARD_INDEX ?? 0);
const WEB_PORT = 4398 + SHARD * 10;
const API_PORT = 3398 + SHARD * 10;
/**
 * A second server, its home's clock 1000 times real time: a home of simulated
 * devices lived through in seconds — a day of a station charging and
 * draining, holds of minutes — for the tests of what happens over time.
 * Read-only, as a fast clock must be; a database of its own. Its tests reach
 * it through the API alone (`fastServer` in helpers.ts).
 */
const FAST_API_PORT = 3399 + SHARD * 10;
const FAST_CLOCK_RATE = 1000;
/** How much longer a test may take on the pipeline's machine than on a developer's. */
const PACE = process.env.CI ? 1.5 : 1;
const state = process.env.E2E_STATE_DIR ?? mkdtempSync(join(tmpdir(), 'kraftverk-e2e-'));
process.env.E2E_STATE_DIR = state;
process.env.E2E_FAST_API = `http://127.0.0.1:${FAST_API_PORT}`;
process.env.E2E_FAST_CLOCK_RATE = String(FAST_CLOCK_RATE);
/**
 * A folder of each server's own: what a server keeps beside its database —
 * its logins (node.db), its node's id, the configuration it keeps, its map —
 * is that server's alone, as on any machine.
 */
const serverDir = (name: string) => {
  const dir = join(state, name);
  mkdirSync(dir, { recursive: true });
  return dir;
};
process.env.E2E_WEB_URL = `http://127.0.0.1:${WEB_PORT}`;

export default defineConfig({
  testDir: '.',
  // *.e2e.ts, not *.spec.ts or *.test.ts: those the unit runner (bun test) picks up.
  testMatch: /.*\.e2e\.ts$/,
  // One server and one database: the tests run in order, each with devices of its own.
  workers: 1,
  fullyParallel: false,
  /*
    Fast is the rule: a test does what a person does, against simulated
    devices, in seconds. One that needs longer is made faster — a faster
    clock, a quicker simulation — not given more time. No retries: a test
    that fails now and then is fixed, not run twice.
  */
  // The pipeline's machine is slower than a developer's: there, half as long again. Made fast here, a test fits there.
  timeout: 15_000 * PACE,
  expect: { timeout: 5_000 * PACE },
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: join(ROOT, 'e2e-report', SHARD ? `shard-${SHARD}` : '') }]] : 'list',
  globalSetup: './setup.ts',
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    // What `request` — the API, for what a test needs to exist — is signed in with. The browser signs itself in (fixtures.ts).
    storageState: join(state, 'signed-in.json'),
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  outputDir: join(ROOT, 'e2e-results', SHARD ? `shard-${SHARD}` : ''),
  webServer: [
    {
      command: 'node scripts/run-bun.mjs server/src/index.ts',
      cwd: ROOT,
      url: `http://127.0.0.1:${API_PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        PORT: String(API_PORT),
        KRAFTVERK_DB: join(serverDir('server'), 'kraftverk.db'),
        KRAFTVERK_LOG_DIR: join(serverDir('server'), 'logs'),
        READ_ONLY: '1',
        // One clock everywhere: a home made here keeps UTC on every machine, as on the pipeline's.
        TZ: 'UTC',
        BROKER_SPAWN: '0',
        ALLOWED_ORIGINS: `http://127.0.0.1:${WEB_PORT}`,
      },
    },
    {
      command: 'node scripts/run-bun.mjs server/src/index.ts',
      cwd: ROOT,
      url: `http://127.0.0.1:${FAST_API_PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        PORT: String(FAST_API_PORT),
        KRAFTVERK_DB: join(serverDir('fast'), 'kraftverk.db'),
        KRAFTVERK_LOG_DIR: join(serverDir('fast'), 'logs'),
        READ_ONLY: '1',
        // One clock everywhere: a home made here keeps UTC on every machine, as on the pipeline's.
        TZ: 'UTC',
        BROKER_SPAWN: '0',
        KRAFTVERK_CLOCK_RATE: String(FAST_CLOCK_RATE),
      },
    },
    {
      command: 'node e2e/serve.mjs',
      cwd: ROOT,
      url: `http://127.0.0.1:${WEB_PORT}`,
      reuseExistingServer: false,
      env: { E2E_WEB_PORT: String(WEB_PORT), E2E_API_PORT: String(API_PORT) },
    },
  ],
});
