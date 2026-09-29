import type { LiveUpdate } from '@kraftverk/api-contract';

import { getApiBaseUrl } from './api';

/**
 * The server's live stream (`GET /api/live`): what changed, as it changes.
 *
 * One socket per app. It says hello when it opens — then read the list, and
 * apply what follows on top of it — and is opened again when it drops, sooner
 * at first and then every half minute, so a server that restarts is back in a
 * second and one that is gone costs next to nothing. While it is down the app
 * polls, as it did before there was a stream; nothing depends on it being up.
 *
 * The session cookie goes with the socket, the way it goes with every request.
 */

export type LiveState = 'connecting' | 'live' | 'down';

/** Waits before opening again, by how many times in a row it failed; then the last, for ever. */
const RETRY_MS = [1000, 2000, 5000, 10_000, 30_000];

/** `http://host:3333/api` → `ws://host:3333/api/live`; a path alone is this page's server. */
export function liveUrl(base: string = getApiBaseUrl()): string {
  const origin = typeof window !== 'undefined' && window.location?.href ? window.location.href : 'http://localhost/';
  const url = new URL(`${base.replace(/\/$/, '')}/live`, origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

export type LiveOptions = {
  onUpdate: (update: LiveUpdate) => void;
  onState?: (state: LiveState) => void;
  /** Where it is; the server the app points at, when not given. */
  url?: string;
  /** For tests: how a socket is made. */
  socket?: (url: string) => WebSocket;
};

/** Opens the stream and keeps it open until `close()`. */
export function openLive(options: LiveOptions): { close(): void } {
  let socket: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let failures = 0;
  let closed = false;
  const state = (next: LiveState) => options.onState?.(next);

  const connect = () => {
    if (closed) return;
    state('connecting');
    let opened = false;
    try {
      const url = options.url ?? liveUrl();
      socket = options.socket ? options.socket(url) : new WebSocket(url);
    } catch {
      retry();
      return;
    }
    socket.onmessage = (message) => {
      let update: LiveUpdate;
      try {
        update = JSON.parse(String(message.data)) as LiveUpdate;
      } catch {
        return;
      }
      if (update.type === 'hello') {
        opened = true;
        failures = 0;
        state('live');
      }
      options.onUpdate(update);
    };
    socket.onclose = () => {
      socket = null;
      if (closed) return;
      if (!opened) failures += 1;
      retry();
    };
    // A socket that fails also closes: that is where it is handled.
    socket.onerror = () => undefined;
  };

  const retry = () => {
    if (closed) return;
    state('down');
    const wait = RETRY_MS[Math.min(failures, RETRY_MS.length - 1)]!;
    // Spread out, so every app that lost the server does not come back in the same instant.
    timer = setTimeout(connect, wait * (0.8 + Math.random() * 0.4));
  };

  connect();
  return {
    close: () => {
      closed = true;
      if (timer) clearTimeout(timer);
      socket?.close();
      socket = null;
    },
  };
}
