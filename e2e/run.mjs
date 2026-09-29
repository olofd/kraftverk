/**
 * npm run test:e2e: builds the app for the web as it ships — talking to its
 * server same-origin — then runs the end-to-end tests against it. Arguments
 * pass through to Playwright (`-- --headed`, `-- charge-window`).
 * E2E_SKIP_BUILD=1 uses the build already in client/dist.
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
/** One command line, through the shell so npm and npx resolve on every platform; its own arguments quoted. */
const run = (line, env = {}) => {
  const result = spawnSync(line, { cwd: ROOT, stdio: 'inherit', shell: true, env: { ...process.env, ...env } });
  if (result.status !== 0) process.exit(result.status ?? 1);
};
const quoted = (arg) => (/^[\w./:=@-]+$/.test(arg) ? arg : JSON.stringify(arg));

if (process.env.E2E_SKIP_BUILD !== '1') run('npm run build:web', { EXPO_PUBLIC_API_URL: 'same-origin' });
run(['npx playwright test -c e2e/playwright.config.ts', ...process.argv.slice(2).map(quoted)].join(' '));
