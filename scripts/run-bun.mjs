#!/usr/bin/env node
/**
 * Runs the server under Bun, finding Bun even when it isn't on PATH.
 *
 * Installing Bun updates the persisted PATH, but already-running shells (and
 * anything they spawn — notably a VS Code integrated terminal, whose tabs
 * inherit the environment VS Code launched with) keep the old one. That
 * produces "'bun' is not recognized" long after a successful install.
 *
 * npm scripts run under Node, which is on PATH by definition, so we resolve
 * Bun ourselves and exec it.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const exe = process.platform === 'win32' ? 'bun.exe' : 'bun';

/** Well-known install locations, in the order we prefer them. */
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

/** First existing install location, or null. PATH is tried before this. */
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
          'Install it:   winget install Oven-sh.Bun',
          '',
          'If you have already installed it, this shell is using a stale PATH.',
          'Restart the terminal — and if you are in VS Code, restart VS Code',
          'itself, because its terminal tabs inherit the environment VS Code',
          'started with.',
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

// Try PATH first; the error handler falls back to known locations.
run(exe);
