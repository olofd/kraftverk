import type { ToolSpec, ValueType } from '@kraftverk/device-sdk';

/**
 * The station's tools, declared as data (NEXT-STEP-ARCHITECTURE.md §4.9): what
 * each asks for and what it answers, in the value system. The app draws any of
 * them as a form and a result with no code of this package's; the contract
 * suite and whoever holds the station check every answer against these.
 */

const INTEGER = { type: 'number', integer: true } as const;
const NUMBER = { type: 'number' } as const;
const TEXT = { type: 'string' } as const;
const TIME = { type: 'timestamp' } as const;
const ON_OFF = { type: 'boolean' } as const;

const choice = (...values: string[]): ValueType => ({ type: 'enum', options: values.map((value) => ({ value, label: value })) });

/** One register, raw and decoded, against the baseline. */
const REGISTER_ROW: ValueType = {
  type: 'object',
  fields: {
    register: INTEGER,
    name: TEXT,
    raw: INTEGER,
    hex: TEXT,
    asTenths: NUMBER,
    writable: {
      type: 'object',
      fields: { kind: choice('set', 'range'), values: { type: 'list', of: INTEGER }, min: INTEGER, max: INTEGER },
      required: ['kind'],
    },
    previous: INTEGER,
    changed: ON_OFF,
  },
  required: ['register', 'raw', 'hex', 'asTenths', 'changed'],
};

export const STATION_TOOLS = {
  registers: {
    label: 'Registers',
    description: 'Every register, raw and decoded, diffed against this station’s own baseline.',
    writes: false,
    answer: {
      type: 'object',
      fields: { mac: TEXT, readOnly: ON_OFF, baselineAt: TIME, input: { type: 'list', of: REGISTER_ROW }, holding: { type: 'list', of: REGISTER_ROW } },
      required: ['readOnly', 'input', 'holding'],
    },
  },
  snapshot: {
    label: 'Snapshot a baseline',
    description: 'Takes the baseline the next register dump is compared with. Changes nothing on the station.',
    writes: false,
    answer: { type: 'object', fields: { at: TIME, input: INTEGER, holding: INTEGER }, required: ['at', 'input', 'holding'] },
  },
  scan: {
    label: 'Scan registers',
    description: 'Reads any register range, shown as ASCII too: strings the station keeps are packed two characters to a register. Reads only.',
    writes: false,
    input: {
      fields: {
        fn: { type: 'number', title: 'Function', description: '3 for holding registers, 4 for input registers.', integer: true, min: 3, max: 4, default: 3 },
        start: { type: 'number', title: 'First register', integer: true, min: 0, max: 65535, default: 0 },
        count: { type: 'number', title: 'How many', integer: true, min: 1, max: 125, default: 40 },
      },
    },
    answer: {
      type: 'object',
      fields: {
        fn: INTEGER,
        start: INTEGER,
        count: INTEGER,
        ok: ON_OFF,
        values: { type: 'list', of: { type: 'object', fields: { register: INTEGER, raw: INTEGER, hex: TEXT }, required: ['register', 'raw', 'hex'] } },
        ascii: TEXT,
      },
      required: ['fn', 'start', 'count', 'ok', 'values', 'ascii'],
    },
  },
  blocked: {
    label: 'Refused writes',
    description: 'Writes this station refused while read-only: its own, not somebody else’s.',
    writes: false,
    answer: { type: 'list', of: { type: 'object', fields: { at: TIME, register: INTEGER, value: INTEGER }, required: ['at', 'register', 'value'] } },
  },
  link: {
    label: 'Link',
    description: 'How the link is doing: what it rides, and what the transport reports about it.',
    writes: false,
    answer: {
      type: 'object',
      fields: {
        transport: TEXT,
        address: TEXT,
        connected: ON_OFF,
        status: {
          type: 'object',
          fields: { mode: choice('device', 'simulator'), state: choice('connected', 'waiting', 'offline'), transport: TEXT, mac: TEXT, lastSeen: TIME },
          required: ['mode', 'state'],
        },
      },
      required: ['transport', 'address', 'connected', 'status'],
    },
  },
  raw: {
    label: 'Send a raw frame',
    description:
      'The escape hatch for protocol work: sends any frame, when the holder was started with raw access. Never past the protocol’s guard, and while read-only only a frame that is plainly a read.',
    writes: true,
    honoursReadOnly: true,
    input: { fields: { hex: { type: 'string', title: 'Frame', description: 'Whole bytes of hexadecimal.', required: true } } },
    answer: { type: 'object', fields: { sent: TEXT, to: TEXT, described: TEXT }, required: ['sent', 'to', 'described'] },
  },
} as const satisfies Readonly<Record<string, ToolSpec>>;
