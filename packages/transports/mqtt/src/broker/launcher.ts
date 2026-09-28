import { spawn } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Starts the broker and gets out of the way.
 *
 * Usage: bun launcher.ts <main.ts> <stdout log>
 *
 * The server does not start the broker directly, for two reasons, and this
 * process is the answer to both.
 *
 * **A child is reachable by a tree kill.** `concurrently` stops `npm run dev`
 * by killing the server's whole process tree (`taskkill /T` on Windows, a
 * parent-pid walk elsewhere), and would take a broker the server started with
 * it — the one thing the broker exists not to suffer. The server starts this
 * instead, this starts the broker, and this exits: the broker's parent is then
 * a process that no longer exists, and no walk from the server finds it.
 *
 * **On Windows, a child inherits handles it was never given.** `CreateProcess`
 * with inheritance on — which Node and Bun use whenever a child has stdio —
 * passes every inheritable handle in the parent, not only the ones named. The
 * server's stdout is `concurrently`'s pipe, so a broker spawned the ordinary way
 * holds that pipe open for as long as it lives, and `concurrently` — or a shell
 * piping `npm run broker:start` anywhere — waits on it indefinitely. Seen, not
 * theorised. So on Windows the broker is created with `CreateProcessW` called
 * directly, inheritance off. It gets its output file from `cmd`'s own
 * redirection instead, which needs nothing inherited.
 *
 * An earlier version went through PowerShell's `Start-Process`, which also
 * passes no handles. It was dropped when PowerShell was seen hanging at startup
 * machine-wide — and a broker that cannot start takes the Wi-Fi station with it.
 *
 * Prints `{"pid": …}` — the broker's on Linux and macOS, `cmd`'s on Windows,
 * which lives exactly as long as the broker — and exits.
 */

const [main, log] = process.argv.slice(2);
if (!main || !log) {
  console.error('usage: launcher.ts <main.ts> <stdout log>');
  process.exit(2);
}

mkdirSync(dirname(log), { recursive: true });

const pid = process.platform === 'win32' ? await createWindows(main, log) : await createPosix(main, log);
console.log(JSON.stringify({ pid }));
process.exit(0);

async function createPosix(main: string, log: string): Promise<number | null> {
  // Appended, not truncated: a crash loop's earlier attempts are the evidence.
  const out = openSync(log, 'a');
  const child = spawn(process.execPath, [main], {
    // Its own session, so no signal aimed at the terminal reaches it either.
    detached: true,
    stdio: ['ignore', out, out],
  });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve(child.pid ?? null);
    });
  });
}

async function createWindows(main: string, log: string): Promise<number | null> {
  const { dlopen, FFIType, ptr } = await import('bun:ffi');
  const kernel32 = dlopen('kernel32.dll', {
    CreateProcessW: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.i32, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
      returns: FFIType.i32,
    },
    // A HANDLE, read back out of PROCESS_INFORMATION as the 64-bit value it is.
    CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
    GetLastError: { args: [], returns: FFIType.u32 },
  });

  const wide = (text: string) => Buffer.from(`${text}\0`, 'utf16le');

  // `/s` makes cmd strip exactly the outer pair of quotes and keep the rest
  // verbatim; `>>` appends, so a crash loop's earlier attempts survive.
  const comspec = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe';
  const commandLine = wide(`"${comspec}" /d /s /c ""${process.execPath}" "${main}" >> "${log}" 2>&1"`);

  // The environment as a block — the server's, plus what it set for the broker.
  const environment = Buffer.from(
    `${Object.entries(process.env)
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .map(([key, value]) => `${key}=${value}\0`)
      .join('')}\0`,
    'utf16le'
  );

  // STARTUPINFOW is 104 bytes on x64 and says only its own size; PROCESS_INFORMATION is 24.
  const startup = new Uint8Array(104);
  new DataView(startup.buffer).setUint32(0, startup.length, true);
  const info = new Uint8Array(24);

  const CREATE_NEW_PROCESS_GROUP = 0x00000200; // Ctrl+C in the server's console does not reach it
  const CREATE_UNICODE_ENVIRONMENT = 0x00000400;
  const CREATE_NO_WINDOW = 0x08000000; // a console of its own, never shown — Bun wants one for its stdio
  const CREATE_BREAKAWAY_FROM_JOB = 0x01000000; // out of any job a terminal kills on close
  const flags = CREATE_NEW_PROCESS_GROUP | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW;

  const create = (extra: number) =>
    kernel32.symbols.CreateProcessW(
      null,
      ptr(commandLine),
      null,
      null,
      0, // bInheritHandles: FALSE. The whole point.
      flags | extra,
      ptr(environment),
      null,
      ptr(startup),
      ptr(info)
    );

  // Break away from the job if the job allows it; if not (ERROR_ACCESS_DENIED),
  // start inside it rather than not at all.
  let created = create(CREATE_BREAKAWAY_FROM_JOB);
  if (!created && kernel32.symbols.GetLastError() === 5) created = create(0);
  if (!created) {
    console.error(`CreateProcessW failed with Windows error ${kernel32.symbols.GetLastError()}`);
    process.exit(1);
  }

  const view = new DataView(info.buffer);
  // hProcess and hThread are ours to close; the process runs on without them.
  kernel32.symbols.CloseHandle(view.getBigUint64(0, true));
  kernel32.symbols.CloseHandle(view.getBigUint64(8, true));
  return view.getUint32(16, true);
}
