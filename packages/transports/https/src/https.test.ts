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
