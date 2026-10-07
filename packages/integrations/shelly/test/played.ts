import { fakeByteChannel, fakeConnection } from '@kraftverk/device-sdk/testing';

import { authOf, readFrames, type SwitchStatus } from '../src/protocol/index.ts';

/*
  A Shelly, played: what a Gen2-and-later device says over its WebSocket at
  /rpc, byte for byte — the handshake's answer, unmasked frames, RPC answers
  and errors, a 401 with its challenge when it has a password, and the
  notifications it sends unasked. Made-up: a Plus Plug S at 192.0.2.60.
*/

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const MAC = 'C4DEE2A1B2C3';
const REALM = 'shellyplusplugs-c4dee2a1b2c3';
const NONCE = 1_700_000_000;

/** A frame as a server sends it: final, text, unmasked. */
function serverFrame(text: string): Uint8Array {
  const payload = encoder.encode(text);
  const header = payload.length < 126 ? [0x81, payload.length] : [0x81, 126, payload.length >> 8, payload.length & 0xff];
  const frame = new Uint8Array(header.length + payload.length);
  frame.set(header);
  frame.set(payload, header.length);
  return frame;
}

export function playedShelly(options: { password?: string; switches?: SwitchStatus[]; gen?: number } = {}) {
  const switches = new Map((options.switches ?? [{ id: 0, output: false, apower: 0, voltage: 231.2, current: 0, freq: 50, aenergy: { total: 1234.5 }, temperature: { tC: 41.2 } }]).map((each) => [each.id, { ...each }]));
  const asked: string[] = [];
  const status = () => ({ ...Object.fromEntries([...switches].map(([id, each]) => [`switch:${id}`, each])), wifi: { rssi: -61, sta_ip: '192.0.2.60' }, sys: { uptime: 3600 } });
  const challenge = { realm: REALM, nonce: NONCE, algorithm: 'SHA-256' };
  const signed = (auth: { cnonce?: number; response?: string } | undefined) =>
    Boolean(options.password && auth?.cnonce !== undefined && authOf(challenge, options.password, auth.cnonce).response === auth.response);

  const answer = (request: { id: number; src: string; method: string; params?: Record<string, unknown>; auth?: { cnonce?: number; response?: string } }): object => {
    asked.push(request.method);
    const reply = (result: unknown) => ({ id: request.id, src: REALM, dst: request.src, result });
    if (request.method === 'Shelly.GetDeviceInfo') {
      return reply({ name: null, id: REALM, mac: MAC, slot: 1, model: 'SNPL-00112EU', gen: options.gen ?? 2, fw_id: '20240819-074343/1.4.2-gc2639da', ver: '1.4.2', app: 'PlusPlugS', auth_en: Boolean(options.password), auth_domain: options.password ? REALM : null });
    }
    // Everything else, behind its password when it has one.
    if (options.password && !signed(request.auth)) return { id: request.id, src: REALM, dst: request.src, error: { code: 401, message: JSON.stringify({ auth_type: 'digest', nonce: NONCE, nc: 1, realm: REALM, algorithm: 'SHA-256' }) } };
    switch (request.method) {
      case 'Shelly.GetStatus':
        return reply(status());
      case 'Switch.Set': {
        const each = switches.get(Number(request.params?.id));
        if (!each) return { id: request.id, src: REALM, dst: request.src, error: { code: -105, message: 'Argument id, value not found' } };
        const was = each.output;
        each.output = request.params?.on === true;
        each.apower = each.output ? 1000 : 0;
        return reply({ was_on: was });
      }
      case 'Switch.GetStatus':
        return reply(switches.get(Number(request.params?.id)));
      default:
        return { id: request.id, src: REALM, dst: request.src, error: { code: 404, message: `No handler for ${request.method}` } };
    }
  };

  let client = '';
  const channel = fakeByteChannel((bytes) => {
    const text = decoder.decode(bytes);
    if (text.startsWith('GET /rpc HTTP/1.1')) {
      return encoder.encode(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', 'Sec-WebSocket-Accept: played', '', ''].join('\r\n'));
    }
    const replies = readFrames(bytes)
      .frames.filter((frame) => frame.opcode === 0x1)
      .map((frame) => {
        const request = JSON.parse(decoder.decode(frame.payload)) as Parameters<typeof answer>[0];
        client = request.src;
        return serverFrame(JSON.stringify(answer(request)));
      });
    return replies.length ? replies : null;
  });

  return {
    channel,
    asked,
    switches,
    /** It tells of a change, unasked, as a device does: only what moved. */
    notify(change: Record<string, unknown>) {
      channel.push(serverFrame(JSON.stringify({ src: REALM, dst: client, method: 'NotifyStatus', params: { ts: 1, ...change } })));
    },
    connection: (secrets: Record<string, string> = {}) => fakeConnection({ method: 'lan', protocol: 'shelly-rpc', transport: 'lan', address: '192.0.2.60', channel, secrets }),
  };
}
