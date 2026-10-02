import { afterEach, expect, test } from 'bun:test';

import { ApiError, type KraftverkApi, type LiveUpdate, type ViewReport } from '@kraftverk/api-contract';

import { apiOver, serveApi } from '../src/index.ts';

/*
  A home's interface across a real MessageChannel, as a browser's page asks
  its worker: answers, refusals in words, the live stream and an abort. The
  whole interface against a real hub is the server's agreement suite
  (server/src/api.test.ts), which asks it this way as well.
*/

const open: MessagePort[] = [];
afterEach(() => {
  for (const port of open.splice(0)) port.close();
});

const wire = (served: Partial<KraftverkApi>) => {
  const channel = new MessageChannel();
  open.push(channel.port1, channel.port2);
  const stop = serveApi(served as KraftverkApi, channel.port2);
  return { api: apiOver(channel.port1), stop };
};

const later = () => new Promise((resolve) => setTimeout(resolve, 10));

test('a call by its path, answered', async () => {
  const { api } = wire({ problems: async (limit?: number) => [{ id: 1, limit } as never], policy: { list: async () => [{ name: 'loadWatts' } as never], set: async () => [] } });
  expect(await api.problems(5)).toEqual([{ id: 1, limit: 5 } as never]);
  expect(await api.policy.list()).toEqual([{ name: 'loadWatts' } as never]);
});

test('a refusal crosses as the ApiError it was, with its problems and its token', async () => {
  const { api } = wire({
    devices: {
      remove: async () => {
        throw new ApiError('needs-yes', 'Say yes first', { needsConfirmation: 'tok-1', problems: ['one', 'two'] });
      },
    } as never,
  });
  const refused = await api.devices.remove('d-1' as never).catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(ApiError);
  expect(refused).toMatchObject({ kind: 'needs-yes', message: 'Say yes first', needsConfirmation: 'tok-1', problems: ['one', 'two'] });
});

test('what a home does not have is refused, and what an object has is no way in', async () => {
  const { api } = wire({ problems: async () => [] });
  expect(await (api as unknown as { nothing: () => Promise<unknown> }).nothing().catch((error: unknown) => error)).toMatchObject({ kind: 'not-found' });
  expect(await (api.problems as unknown as { constructor: () => Promise<unknown> }).constructor().catch((error: unknown) => error)).toMatchObject({ kind: 'not-found' });
  expect(await (api as unknown as { toString: () => Promise<unknown> }).toString().catch((error: unknown) => error)).toMatchObject({ kind: 'not-found' });
});

test('awaiting a part of the interface is not a call', async () => {
  const { api } = wire({});
  expect(await Promise.resolve(api.devices)).toBe(api.devices);
});

test('a setup step aborted here is aborted there', async () => {
  let seen: AbortSignal | null = null;
  const { api } = wire({
    setup: {
      action: (_id: string, _step: string, _action: string, _input: unknown, signal?: AbortSignal) =>
        new Promise((resolve) => {
          seen = signal ?? null;
          signal?.addEventListener('abort', () => resolve({ ok: false, detail: 'aborted' }));
        }),
    } as never,
  });
  const controller = new AbortController();
  const running = api.setup.action('s-1', 'key', 'fetch', {}, controller.signal);
  await later();
  expect(seen!.aborted).toBe(false);
  controller.abort();
  expect(await running).toEqual({ ok: false, detail: 'aborted' });
  expect(seen!.aborted).toBe(true);
});

test('the live stream: what moved arrives, what the screen shows is said, and closing it closes it there', async () => {
  const said: ViewReport[] = [];
  let listener: ((update: LiveUpdate) => void) | null = null;
  let closed = false;
  const { api, stop } = wire({
    live: (heard: (update: LiveUpdate) => void) => {
      listener = heard;
      return { say: (view: ViewReport) => void said.push(view), close: () => void (closed = true) };
    },
  });
  const heard: LiveUpdate[] = [];
  const stream = api.live((update) => heard.push(update));
  await later();
  listener!({ type: 'hello', at: '2026-10-02T00:00:00Z' } as LiveUpdate);
  stream.say({ type: 'view', screen: 'home', showing: [] });
  await later();
  expect(heard).toEqual([{ type: 'hello', at: '2026-10-02T00:00:00Z' } as LiveUpdate]);
  expect(said).toEqual([{ type: 'view', screen: 'home', showing: [] }]);
  stream.close();
  await later();
  expect(closed).toBe(true);
  stop();
});
