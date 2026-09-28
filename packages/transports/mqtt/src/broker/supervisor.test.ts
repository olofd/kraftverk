import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { brokerToken, paths } from './shared.ts';
import { BrokerSupervisor, probeHealth } from './supervisor.ts';

/**
 * The supervisor against a real broker process: started detached, attached to
 * by a second supervisor instead of started twice, and replaced when it dies.
 *
 * Real processes and real ports, because the whole point is behaviour across
 * process boundaries — nothing in-process would prove it.
 */

const dir = mkdtempSync(join(tmpdir(), 'kraftverk-broker-'));
const started: number[] = [];

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

const mqttPort = await freePort();
const adminPort = await freePort();
const adminUrl = `http://127.0.0.1:${adminPort}`;

function supervisor(spawn = true) {
  const log: string[] = [];
  const instance = new BrokerSupervisor({
    adminUrl,
    mqtt: { host: '127.0.0.1', port: mqttPort },
    spawn,
    dir,
    env: {
      MQTT_HOST: '127.0.0.1',
      MQTT_PORT: String(mqttPort),
      BROKER_ADMIN_HOST: '127.0.0.1',
      BROKER_ADMIN_PORT: String(adminPort),
      BROKER_LOG_LEVEL: 'off',
    },
    log: (message) => log.push(message),
    startTimeoutMs: 15_000,
  });
  return { instance, log };
}

async function shutdown(): Promise<void> {
  await fetch(`${adminUrl}/shutdown?reason=test`, {
    method: 'POST',
    headers: { authorization: `Bearer ${brokerToken(dir)}` },
  }).catch(() => undefined);
  for (let i = 0; i < 50 && (await probeHealth(adminUrl, 300)); i++) await Bun.sleep(100);
}

afterAll(async () => {
  await shutdown();
  for (const pid of started) {
    try {
      process.kill(pid);
    } catch {
      // Already gone, which is the expected state.
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('BrokerSupervisor', () => {
  test('starts a broker when none is running', async () => {
    const { instance } = supervisor();
    const state = await instance.ensure();

    expect(state.status).toBe('running');
    expect(state.started).toBe(1);
    expect(state.buildMatches).toBe(true);
    expect(state.health?.pid).not.toBe(process.pid);
    started.push(state.health!.pid);

    // It wrote down where it is, and opened its journal.
    const recorded = JSON.parse(readFileSync(paths(dir).state, 'utf8')) as { pid: number };
    expect(recorded.pid).toBe(state.health!.pid);
  }, 20_000);

  test('a second server attaches to it rather than starting another', async () => {
    const { instance } = supervisor();
    const state = await instance.ensure();
    expect(state.status).toBe('running');
    expect(state.started).toBe(0);
    expect(state.health?.pid).toBe(started[0]!);
  });

  test('the admin API wants the token for anything but health', async () => {
    expect((await fetch(`${adminUrl}/status`)).status).toBe(401);
    const status = await fetch(`${adminUrl}/status`, { headers: { authorization: `Bearer ${brokerToken(dir)}` } });
    expect(status.status).toBe(200);
  });

  test('one that may not start a broker says so instead', async () => {
    await shutdown();
    const { instance } = supervisor(false);
    const state = await instance.ensure();
    expect(state.status).toBe('down');
    expect(state.error).toContain('own service');
  }, 10_000);

  test('a broker that died is replaced', async () => {
    const { instance } = supervisor();
    const state = await instance.ensure();
    expect(state.status).toBe('running');
    expect(state.started).toBe(1);
    expect(state.health?.pid).not.toBe(started[0]!);
    started.push(state.health!.pid);
  }, 20_000);

  test('a port held by something else is named, not fought over', async () => {
    await shutdown();
    const squatter = createServer(() => undefined);
    await new Promise<void>((resolve) => squatter.listen(mqttPort, '127.0.0.1', resolve));
    try {
      const { instance } = supervisor();
      const state = await instance.ensure();
      expect(state.status).toBe('foreign');
      expect(state.error).toContain('not a kraftverk broker');
    } finally {
      await new Promise<void>((resolve) => squatter.close(() => resolve()));
    }
  }, 10_000);
});
