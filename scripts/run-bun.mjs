#!/usr/bin/env node
/**
 * Runs the server under Bun, using the copy this project pins.
 *
 * Bun is a devDependency (`bun` on npm, which pulls the right
 * `@oven/bun-<platform>` binary), so `npm install` is the only setup step and
 * everyone gets the same version on macOS and Windows alike. We resolve that
 * binary ourselves because npm scripts run under Node, and a globally
 * installed Bun — if one exists at all — may be a different, older version.
 *
 * A global install is still honoured as a fallback, which keeps working for
 * anyone who set the project up before Bun was vendored. That path also covers
 * the stale-PATH case: installing Bun updates the persisted PATH, but
 * already-running shells (notably a VS Code integrated terminal, whose tabs
 * inherit the environment VS Code launched with) keep the old one.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';

const exe = process.platform === 'win32' ? 'bun.exe' : 'bun';

/**
 * The pinned binary, found by walking up from this script to the workspace
 * root. The npm package names it `bun.exe` on every platform, so this one path
 * works everywhere — and pointing at it directly avoids `node_modules/.bin`,
 * whose Windows entry is a `.cmd` shim that `spawn` cannot exec without a
 * shell.
 */
function localBun() {
  let dir = dirname(fileURLToPath(import.meta.url));
  const { root } = parse(dir);

  while (true) {
    const candidate = join(dir, 'node_modules', 'bun', 'bin', 'bun.exe');
    if (existsSync(candidate)) return candidate;
    if (dir === root) return null;
    dir = dirname(dir);
  }
}

/** Well-known global install locations, in the order we prefer them. */
function candidates() {
  const home = homedir();
  const local = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');

  return [
    // Official installer / `bun upgrade`
    join(home, '.bun', 'bin', exe),
    // winget
    join(
      local,
      'Microsoft',
      'WinGet',
      'Packages',
      'Oven-sh.Bun_Microsoft.Winget.Source_8wekyb3d8bbwe',
      'bun-windows-x64',
      exe
    ),
    join(local, 'Microsoft', 'WinGet', 'Links', exe),
    // scoop / homebrew / linux packages
    join(home, 'scoop', 'shims', exe),
    '/opt/homebrew/bin/bun',
    '/usr/local/bin/bun',
  ];
}

/** First existing global install location, or null. */
function resolveBun() {
  return candidates().find((candidate) => existsSync(candidate)) ?? null;
}

const args = process.argv.slice(2);

function run(command) {
  const child = spawn(command, args, { stdio: 'inherit', shell: false });

  child.on('error', (error) => {
    if (command !== exe) {
      console.error(`Failed to start Bun at ${command}: ${error.message}`);
      process.exit(1);
    }
    // PATH lookup failed — fall back to the known install locations.
    const resolved = resolveBun();
    if (!resolved) {
      console.error(
        [
          '',
          'Bun is required to run the server, and it could not be found.',
          '',
          'It ships with the project, so this usually means dependencies are',
          'not installed yet. From the repository root:',
          '',
          '    npm install',
          '',
          'If that has already been run, the install scripts may have been',
          'declined — npm 11 blocks them by default. Re-run:',
          '',
          '    npm install',
          '',
          'and approve, or run `npm approve-scripts bun`.',
          '',
        ].join('\n')
      );
      process.exit(1);
    }
    run(resolved);
  });

  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });
}

// The pinned copy wins; otherwise try PATH, then known global locations.
run(localBun() ?? exe);
