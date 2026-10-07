import { expect, test } from 'bun:test';

import { httpChannel, originOf } from './index.ts';

test('a channel reaches its own origin and no other', async () => {
  const asked: string[] = [];
  const fake = (async (url: URL | string) => {
    asked.push(String(url));
    return new Response('{}');
  }) as typeof fetch;
  const channel = httpChannel('https://api.example.test', fake);

  await channel.fetch('/v1/forecast?latitude=59');
  expect(asked).toEqual(['https://api.example.test/v1/forecast?latitude=59']);
  await expect(channel.fetch('https://elsewhere.test/steal')).rejects.toThrow('is all this connection may reach');
  await expect(channel.fetch('//elsewhere.test/steal')).rejects.toThrow();
  expect(asked).toHaveLength(1);
});

test('a protocol may name a host beside its API — a sign-in host — and every other is still refused', async () => {
  const asked: string[] = [];
  const fake = (async (url: URL | string) => {
    asked.push(String(url));
    return new Response('{}');
  }) as typeof fetch;
  const channel = httpChannel('https://api.example.test', fake, ['https://account.example.test']);

  await channel.fetch('/v5/list');
  await channel.fetch('https://account.example.test/oauth2/token');
  expect(asked).toEqual(['https://api.example.test/v5/list', 'https://account.example.test/oauth2/token']);
  await expect(channel.fetch('https://elsewhere.test/steal')).rejects.toThrow('is all this connection may reach');
  // Only HTTPS, there too.
  expect(() => httpChannel('https://api.example.test', fake, ['http://account.example.test'])).toThrow('not an HTTPS address');
  expect(channel.describe?.()).toMatchObject({ origin: 'https://api.example.test', alsoOrigins: ['https://account.example.test'] });
});

test('a service whose hosts are numbered is named by its domain: any host under it, over HTTPS, and nothing beside', async () => {
  const asked: string[] = [];
  const fake = (async (url: URL | string) => {
    asked.push(String(url));
    return new Response('{}');
  }) as typeof fetch;
  const channel = httpChannel('https://setup.example.test', fake, ['https://*.example.test']);
  await channel.fetch('https://p42-find.example.test:443/client/refresh');
  await channel.fetch('https://p7-find.eu.example.test/client/refresh');
  expect(asked).toEqual(['https://p42-find.example.test/client/refresh', 'https://p7-find.eu.example.test/client/refresh']);
  // Not the domain's look-alikes, another port, nor plain HTTP.
  for (const elsewhere of ['https://example.test.evil.test/', 'https://evilexample.test/', 'https://p42.example.test:8443/', 'http://p42.example.test/']) {
    await expect(channel.fetch(elsewhere)).rejects.toThrow('is all this connection may reach');
  }
  // A pattern is a whole domain after "*.", never a partial name.
  expect(() => httpChannel('https://setup.example.test', fake, ['https://*example.test'])).toThrow();
});

test('an address must be HTTPS', () => {
  expect(originOf('https://api.example.test/path')).toBe('https://api.example.test');
  expect(() => originOf('http://api.example.test')).toThrow('not an HTTPS address');
});

test('unreachable is said as a disconnection, and answering again as a connection', async () => {
  let fail = true;
  const fake = (async () => {
    if (fail) throw new Error('offline');
    return new Response('{}');
  }) as unknown as typeof fetch;
  const channel = httpChannel('https://api.example.test', fake);
  const states: boolean[] = [];
  channel.onConnectedChange((connected) => states.push(connected));
  await expect(channel.fetch('/')).rejects.toThrow('offline');
  fail = false;
  await channel.fetch('/');
  expect(states).toEqual([false, true]);
});
