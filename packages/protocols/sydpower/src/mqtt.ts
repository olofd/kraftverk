import type { MessageBrokerPolicy } from '@kraftverk/device-sdk';

import { commandRefusal } from './guard.ts';
import { describeCommand, FN, parseCommand, parseFrame, toHex } from './modbus.ts';

/**
 * How a Sydpower station rides MQTT.
 *
 * A station on Wi-Fi connects to a broker — the vendor's, or ours when BrightEMS's
 * *Local MQTT Broker* setting points at it — and names itself in every topic by
 * its Bluetooth MAC (docs/P280-FINDINGS.md). It answers on
 * `<MAC>/device/response/…` and takes commands on `<MAC>/client/request/data`:
 * the same MODBUS frames it carries over Bluetooth.
 */

/** `<MAC>/device/response/[client/]<channel>`, where every station speaks. */
export const RESPONSE_TOPIC = /^([0-9A-Fa-f]{12})\/device\/response\/(?:client\/)?(\w+)$/;

/**
 * Commands to a station travel on `<station>/client/request/<channel>`.
 *
 * The station subscribes there and executes whatever MODBUS frame arrives —
 * writes included. Observed on an AFERIY station in BrightEMS's local-broker mode on
 * 2026-09-26: reads and writes both accepted on `<station>/client/request/data`.
 *
 * Matched wherever `client/request` appears as whole segments, not only in
 * second place: a leading slash or an extra level makes a different topic, and
 * a denylist should not be one spelling away from not applying.
 */
export const COMMAND_TOPIC = /(?:^|\/)client\/request(?:\/|$)/i;

/** `<MAC>/client/request/...`, which a station subscribes to. */
export const STATION_COMMAND_FILTER = /^([0-9A-Fa-f]{12})\/client\/request(?:\/|$)/;

export const TOPICS = {
  /** Everything one station says. */
  responses: (mac: string) => `${mac.toUpperCase()}/device/response/#`,
  /**
   * Where a station takes commands. Upper-case, as a station names itself in
   * every topic it uses; a station subscribing in lower case would show up in
   * the broker's journal as `command.undelivered`.
   */
  command: (mac: string) => `${mac.toUpperCase()}/client/request/data`,
} as const;

/** The channel a response arrives on: telemetry on `04`, everything else on `data`. */
export const channelOf = (topic: string): string | null => RESPONSE_TOPIC.exec(topic)?.[2] ?? null;

const printable = (payload: Uint8Array): string | null => {
  if (payload.length === 0 || payload.length > 200) return null;
  for (const byte of payload) if (byte < 0x20 || byte > 0x7e) return null;
  return new TextDecoder().decode(payload);
};

/** What the broker applies for Sydpower stations. See `MessageBrokerPolicy`. */
export const brokerPolicy: MessageBrokerPolicy = {
  protocol: 'sydpower',

  fromDevice(topic) {
    const match = RESPONSE_TOPIC.exec(topic);
    return match ? { address: match[1]!.toUpperCase(), channel: match[2]! } : null;
  },

  subscribedBy(filter) {
    return STATION_COMMAND_FILTER.exec(filter)?.[1]?.toUpperCase() ?? null;
  },

  commandFor(topic) {
    if (!COMMAND_TOPIC.test(topic)) return null;
    const first = topic.split('/')[0] ?? '';
    // A command topic that names no station is still a command topic: it is
    // refused to anyone but the server, and the guard still reads its frame.
    return /^[0-9A-Fa-f]{12}$/.test(first) ? first.toUpperCase() : topic;
  },

  refuse: commandRefusal,

  describeCommand(payload) {
    const command = parseCommand(payload);
    const summary = describeCommand(payload);
    // Writes are the events that change hardware, so they are always in plain
    // sight. Polls are an entry every few seconds, and live in the file.
    if (command?.kind === 'read') {
      return { summary, level: 'debug', awaits: command.fn === FN.READ_INPUT ? 'input' : 'holding' };
    }
    if (command?.kind === 'write') return { summary, level: 'info', awaits: `write:${command.register}` };
    return { summary, level: 'info' };
  },

  describeMessage(channel, payload) {
    if (channel === 'state') return { summary: `state "${printable(payload) ?? toHex(payload)}"`, level: 'info' };
    const frame = parseFrame(payload);
    if (frame?.kind === 'registers') {
      const block = frame.fn === FN.READ_INPUT ? 'input' : 'holding';
      // Stations push telemetry unprompted, and how often is one of the open
      // questions about this protocol, so an unasked one is measured.
      return { summary: `${block} registers ${frame.start ?? '?'}+${frame.values.length}`, level: 'debug', answers: block, periodic: true };
    }
    if (frame?.kind === 'writeAck') {
      return {
        summary: `acknowledged write holding ${frame.register} = ${frame.value}`,
        level: 'info',
        answers: `write:${frame.register}`,
      };
    }
    if (frame?.kind === 'error') {
      return {
        summary: `MODBUS exception ${frame.code} for function 0x${frame.fn.toString(16).padStart(2, '0')}`,
        level: 'warn',
      };
    }
    return { summary: `${payload.length} B that do not parse as a frame (bad CRC or unknown shape)`, level: 'info' };
  },

  absenceAdvice:
    'A station has been seen to stop retrying after a long broker outage: if it still answers pings, ' +
    'power-cycle it, or re-save the Local MQTT Broker setting in BrightEMS.',
};
