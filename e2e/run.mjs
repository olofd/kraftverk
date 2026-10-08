/**
 * npm run test:e2e: builds the app for the web as it ships — talking to its
 * server same-origin — then runs the end-to-end tests against it. Arguments
 * pass through to Playwright (`-- --headed`, `-- charge-window`).
 * E2E_SKIP_BUILD=1 uses the build already in client/dist.
 *
 * `-- --shards=N` runs the suite as N shards side by side, on the one build:
 * each a Playwright of its own, with its own ports, servers and results
 * (playwright.config.ts, E2E_SHARD_INDEX), its lines marked [1], [2]… It
 * fails when any shard does. The tests in one shard still run one after
 * another, against its one database.
 */
import { spawn, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
/** One command line, through the shell so npm and npx resolve on every platform; its own arguments quoted. */
const run = (line, env = {}) => {
  const result = spawnSync(line, { cwd: ROOT, stdio: 'inherit', shell: true, env: { ...process.env, ...env } });
  if (result.status !== 0) process.exit(result.status ?? 1);
};
const quoted = (arg) => (/^[\w./:=@-]+$/.test(arg) ? arg : JSON.stringify(arg));

const args = process.argv.slice(2);
const shardsArg = args.find((arg) => arg.startsWith('--shards='));
const shards = shardsArg ? Number(shardsArg.slice('--shards='.length)) : 1;
const passed = args.filter((arg) => arg !== shardsArg).map(quoted);
const playwright = ['npx playwright test -c e2e/playwright.config.ts', ...passed];

if (process.env.E2E_SKIP_BUILD !== '1') run('npm run build:web', { EXPO_PUBLIC_API_URL: 'same-origin' });
if (!(shards > 1)) run(playwright.join(' '));
else {
  /** One shard, its output line by line with its number in front. */
  const shard = (index) =>
    new Promise((done) => {
      const child = spawn([...playwright, `--shard=${index}/${shards}`].join(' '), { cwd: ROOT, shell: true, env: { ...process.env, E2E_SHARD_INDEX: String(index) } });
      for (const stream of [child.stdout, child.stderr]) {
        let rest = '';
        stream.on('data', (chunk) => {
          const lines = (rest + chunk).split('\n');
          rest = lines.pop() ?? '';
          for (const line of lines) process.stdout.write(`[${index}] ${line}\n`);
        });
        stream.on('end', () => rest && process.stdout.write(`[${index}] ${rest}\n`));
      }
      child.on('close', (code) => done(code ?? 1));
    });
  const codes = await Promise.all(Array.from({ length: shards }, (_, at) => shard(at + 1)));
  const failed = codes.map((code, at) => (code === 0 ? null : at + 1)).filter(Boolean);
  if (failed.length) console.log(`Shard${failed.length > 1 ? 's' : ''} ${failed.join(', ')} of ${shards} failed`);
  process.exit(failed.length ? 1 : 0);
}
