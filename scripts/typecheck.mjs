/**
 * npm run typecheck: every workspace's own typecheck, and the end-to-end
 * tests' and the shared config's — side by side, as many at once as the
 * machine has cores (each a tsc of its own, a few hundred MB), not one after
 * another. Each one's output is printed whole when it ends; it fails when
 * any does. The compiler is started directly — every workspace's typecheck
 * is `tsc --noEmit` — not through npm, whose start costs more than most
 * packages' check (TypeScript 7 checks the hub, and all it imports, in half
 * a second).
 */
import { spawn, spawnSync } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

// Every workspace with a typecheck of its own, as npm knows them.
const query = spawnSync('npm query .workspace', { cwd: ROOT, shell: true, encoding: 'utf8' });
if (query.status !== 0) {
  process.stderr.write(query.stderr);
  process.exit(1);
}
const workspaces = JSON.parse(query.stdout).filter((workspace) => workspace.scripts?.typecheck);
const other = workspaces.filter((workspace) => workspace.scripts.typecheck !== 'tsc --noEmit');
if (other.length) throw new Error(`A typecheck this script does not know how to run directly: ${other.map((workspace) => `${workspace.name} (${workspace.scripts.typecheck})`).join(', ')}`);

const TSC = `"${process.execPath}" "${resolve(ROOT, 'node_modules/typescript/bin/tsc')}"`;
const checks = [
  ...workspaces.map((workspace) => ({ name: workspace.name, line: `${TSC} --noEmit`, cwd: resolve(ROOT, workspace.location) })),
  { name: 'e2e', line: `${TSC} --noEmit -p e2e`, cwd: ROOT },
  { name: 'tsconfig.shared.json', line: `${TSC} --noEmit -p tsconfig.shared.json`, cwd: ROOT },
];

const check = ({ name, line, cwd }) =>
  new Promise((done) => {
    const child = spawn(line, { cwd, shell: true });
    let said = '';
    child.stdout.on('data', (chunk) => (said += chunk));
    child.stderr.on('data', (chunk) => (said += chunk));
    child.on('close', (code) => {
      if (code !== 0) process.stdout.write(`\n✗ ${name}\n${said}`);
      done(code === 0 ? null : name);
    });
  });

checks.sort((a, b) => (b.name === 'kraftverk-client') - (a.name === 'kraftverk-client'));
const at = Math.min(availableParallelism(), 6);
const failed = [];
let next = 0;
await Promise.all(
  Array.from({ length: at }, async () => {
    while (next < checks.length) {
      const failure = await check(checks[next++]);
      if (failure) failed.push(failure);
    }
  })
);
if (failed.length) {
  console.log(`\nTypes do not check in: ${failed.join(', ')}`);
  process.exit(1);
}
console.log(`Types check: ${checks.length} projects, ${at} at a time.`);
