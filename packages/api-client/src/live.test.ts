import { describe, expect, test } from 'bun:test';

import type { LiveState } from '@kraftverk/api-contract';

import { openLive } from './live.ts';

/*
  The live stream, over sockets of the tests' own: one that never says hello
  — a server gone from the network, a proxy that passes nothing on — is given
  up on, so the app is down and polls rather than waiting minutes, and it is
  tried again.
*/

type Fake = { closed: boolean; close(): void; send(): void; onmessage: ((message: { data: string }) => void) | null; onclose: (() => void) | null; onerror: (() => void) | null };

const aSocket = (): Fake => ({
  closed: false,
  close() {
    this.closed = true;
  },
  send() {},
  onmessage: null,
  onclose: null,
  onerror: null,
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('the live stream', () => {
  test('a socket that never says hello is given up on: down, closed, and tried again', async () => {
    const sockets: Fake[] = [];
    const states: LiveState[] = [];
    const live = openLive({
      url: 'ws://192.0.2.10:3333/api/live',
      onUpdate: () => {},
      onState: (state) => states.push(state),
      socket: () => {
        const socket = aSocket();
        sockets.push(socket);
        return socket as never;
      },
      helloWithinMs: 30,
    });
    await wait(60);
    expect(states.slice(0, 2)).toEqual(['connecting', 'down']);
    expect(sockets[0]!.closed).toBe(true);
    // Its own close, late, changes nothing more: tried again once, not twice.
    sockets[0]!.onclose?.();
    await wait(2_500);
    expect(sockets).toHaveLength(2);
    live.close();
  });

  test('one that says hello is live, and is not given up on', async () => {
    const sockets: Fake[] = [];
    const states: LiveState[] = [];
    const live = openLive({
      url: 'ws://192.0.2.10:3333/api/live',
      onUpdate: () => {},
      onState: (state) => states.push(state),
      socket: () => {
        const socket = aSocket();
        sockets.push(socket);
        return socket as never;
      },
      helloWithinMs: 30,
    });
    sockets[0]!.onmessage?.({ data: JSON.stringify({ type: 'hello' }) });
    await wait(60);
    expect(states).toEqual(['connecting', 'live']);
    expect(sockets[0]!.closed).toBe(false);
    live.close();
  });
});
