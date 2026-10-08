import { randomBytes } from 'node:crypto';

import { actor } from '@kraftverk/device-sdk';
import { AuditLog, NodeStore } from '@kraftverk/store';

import { besideDatabase, loadConfig } from '../config.ts';
import { openDatabase, openNodeDatabase } from '../platform/database.ts';
import { AccountError, Accounts } from './accounts.ts';

/**
 * `npm run users -- <command>` — accounts, from a shell on the server.
 *
 * For the day the app cannot help: every password forgotten, and nobody
 * able to log in. Having a shell on
 * the server is the proof of ownership here — in Docker:
 *
 *   docker compose exec kraftverk bun run server/src/auth/cli.ts <command>
 *
 *   list                      every account
 *   add <name>                a new account
 *   password <name>           a new password for an account; signs it out everywhere
 *   remove <name>             delete an account (not the last one)
 *   signout <name>            end every session of an account
 *
 * A password is never taken as an argument, where shell history and the process
 * list would keep it. By default one is generated and printed once; to choose
 * your own, pipe it in:  echo -n 'a long password' | … password olof --stdin
 */

// The node's database, as the server finds it — the accounts in it — and the family's timeline.
const config = loadConfig();
const accounts = new Accounts(openNodeDatabase(besideDatabase(config, 'node.db')).database);
const family = openDatabase(config.databaseFile).database;
const timeline = new AuditLog(family);

const [command, ...rest] = process.argv.slice(2);
const name = rest.find((arg) => !arg.startsWith('--'));
const fromStdin = rest.includes('--stdin');

async function newPassword(): Promise<{ password: string; show: boolean }> {
  if (fromStdin) return { password: (await Bun.stdin.text()).replace(/\r?\n$/, ''), show: false };
  return { password: randomBytes(18).toString('base64url'), show: true };
}

function requireName(): string {
  if (!name) fail(`Name the account: ${command} <name>`);
  return name!;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const record = (kind: string, summary: string, account: string) =>
  timeline.record({ at: new Date().toISOString(), kind, actor: actor('system', 'the server console'), resourceKind: 'account', resource: account, summary });

try {
  switch (command) {
    case 'list': {
      const users = accounts.listUsers();
      if (users.length === 0) console.log('No accounts. The first can be created from the app on the home network, or with `add`.');
      for (const user of users) {
        console.log(`${user.username.padEnd(24)} created ${user.createdAt.slice(0, 10)}${user.lastLoginAt ? `, last login ${user.lastLoginAt.slice(0, 16).replace('T', ' ')}` : ', never logged in'}`);
      }
      break;
    }
    case 'add': {
      const username = requireName();
      const { password, show } = await newPassword();
      const user = accounts.countUsers() === 0 ? await accounts.createFirstUser(username, password) : await accounts.createUser(username, password, 'server console');
      record('user.created', `Created ${user.username} from the server console`, user.id);
      console.log(`Created ${user.username}.`);
      if (show) console.log(`Password: ${password}\nIt is not stored anywhere readable and will not be shown again.`);
      break;
    }
    case 'password': {
      const user = accounts.findUserByName(requireName()) ?? fail(`No account called ${name}`);
      const { password, show } = await newPassword();
      await accounts.setPassword(user.id, password);
      record('user.password', `Set a new password for ${user.username} from the server console; their sessions were signed out`, user.id);
      console.log(`New password set for ${user.username}; every session it had was signed out.`);
      if (show) console.log(`Password: ${password}\nIt is not stored anywhere readable and will not be shown again.`);
      break;
    }
    case 'remove': {
      const user = accounts.findUserByName(requireName()) ?? fail(`No account called ${name}`);
      accounts.deleteUser(user.id);
      new NodeStore(family).forgetJoinedFrom(user.id);
      record('user.removed', `Removed ${user.username} from the server console`, user.id);
      console.log(`Removed ${user.username}.`);
      break;
    }
    case 'signout': {
      const user = accounts.findUserByName(requireName()) ?? fail(`No account called ${name}`);
      const ended = accounts.endAllSessions(user.id);
      record('auth.signout', `Signed ${user.username} out everywhere from the server console`, user.id);
      console.log(`Ended ${ended} session(s) for ${user.username}.`);
      break;
    }
    default:
      fail('Commands: list, add <name>, password <name>, remove <name>, signout <name>');
  }
} catch (error) {
  if (error instanceof AccountError) fail(error.message);
  throw error;
}
