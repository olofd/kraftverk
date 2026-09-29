import { mkdtempSync } from 'node:fs';
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
const WEB_PORT = 4398;
const API_PORT = 3398;
const state = process.env.E2E_STATE_DIR ?? mkdtempSync(join(tmpdir(), 'kraftverk-e2e-'));
process.env.E2E_STATE_DIR = state;

export default defineConfig({
  testDir: '.',
  // *.e2e.ts, not *.spec.ts or *.test.ts: those the unit runner (bun test) picks up.
  testMatch: /.*\.e2e\.ts$/,
  // One server and one database: the tests run in order, each with devices of its own.
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: join(ROOT, 'e2e-report') }]] : 'list',
  globalSetup: './setup.ts',
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    storageState: join(state, 'signed-in.json'),
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  outputDir: join(ROOT, 'e2e-results'),
  webServer: [
    {
      command: 'node scripts/run-bun.mjs server/src/index.ts',
      cwd: ROOT,
      url: `http://127.0.0.1:${API_PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        PORT: String(API_PORT),
        KRAFTVERK_DB: join(state, 'kraftverk.db'),
        KRAFTVERK_LOG_DIR: join(state, 'logs'),
        READ_ONLY: '1',
        BROKER_SPAWN: '0',
        ALLOWED_ORIGINS: `http://127.0.0.1:${WEB_PORT}`,
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
