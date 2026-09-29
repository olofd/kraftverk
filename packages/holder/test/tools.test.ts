import { describe, expect, test } from 'bun:test';

import type { DeviceDescription, DeviceSession, ToolSpec, Value } from '@kraftverk/device-sdk';

import { deviceReader, runTool, toolsOf, ToolRefused } from '../src/index.ts';

/*
  What a device declares as data, held to its declaration by whoever holds it:
  a tool's input and answer, and a capability's query answer. A package that
  drifts from what it declared is refused, saying where.
*/

const now = () => new Date().toISOString();

const DUMP: ToolSpec = {
  label: 'Registers',
  description: 'Every register.',
  writes: false,
  input: { fields: { count: { type: 'number', title: 'How many', integer: true, min: 1, max: 10, default: 2 } } },
  answer: { type: 'list', of: { type: 'number', integer: true } },
};
const BLINK: ToolSpec = { label: 'Blink', description: 'Blinks it.', writes: true, answer: { type: 'boolean' } };

const session = (tools: Record<string, (input: Record<string, unknown>) => Promise<Value>>): DeviceSession => ({
  health: () => ({ status: 'connected', detail: 'Fine', lastReadingAt: now() }),
  readings: () => [],
  command: async () => ({ accepted: true }),
  tools,
  close: async () => {},
});

const refusal = async (work: Promise<unknown>): Promise<[string, string]> => {
  try {
    await work;
    return ['none', ''];
  } catch (error) {
    return error instanceof ToolRefused ? [error.reason, error.message] : ['thrown', (error as Error).message];
  }
};

describe('a tool', () => {
  test('runs with its input checked and defaulted, and its answer checked', async () => {
    const seen: unknown[] = [];
    const open = session({
      dump: async (input) => {
        seen.push(input);
        return Array.from({ length: Number(input.count) }, (_, index) => index);
      },
    });
    expect(await runTool({ deviceName: 'Station', name: 'dump', spec: DUMP, session: open, input: {}, readOnly: false })).toEqual([0, 1]);
    expect(seen).toEqual([{ count: 2 }]);
    expect(await refusal(runTool({ deviceName: 'Station', name: 'dump', spec: DUMP, session: open, input: { count: 99 }, readOnly: false }))).toEqual(['input', 'How many must be at most 10']);
  });

  test('that answers something it does not declare is refused, saying where', async () => {
    const open = session({ dump: async () => [1, 'two'] });
    expect(await refusal(runTool({ deviceName: 'Station', name: 'dump', spec: DUMP, session: open, input: {}, readOnly: false }))).toEqual([
      'answer',
      'dump answered something it does not declare: its answer [1] must be a number',
    ]);
  });

  test('that writes is refused while read-only; one its type does not declare does not exist', async () => {
    const open = session({ blink: async () => true, secret: async () => 1 });
    expect(await refusal(runTool({ deviceName: 'Station', name: 'blink', spec: BLINK, session: open, input: {}, readOnly: true }))).toEqual(['read-only', 'Every write to hardware is refused: read-only']);
    expect(await refusal(runTool({ deviceName: 'Station', name: 'secret', spec: undefined, session: open, input: {}, readOnly: false }))).toEqual(['missing', 'Station has no tool called "secret"']);
    // Only what is declared and implemented is listed.
    expect(toolsOf({ blink: BLINK, dump: DUMP }, open).map((tool) => tool.name)).toEqual(['blink']);
  });
});

describe('a device as a function sees it', () => {
  const description: DeviceDescription = { parts: [{ id: 'main', label: 'Forecast', kind: 'forecast', offers: ['weather.forecast'] }], attributes: [] };

  test('answers a query in the type its capability declares, and nothing else', async () => {
    let answer: Value = [{ at: '2026-09-29T07:00:00Z', cloudCover: 40 }];
    const reader = deviceReader({ ...session({}), query: async () => answer }, () => description);
    expect(await reader.query({ part: 'main', capability: 'weather.forecast', query: 'hourly', args: { hours: 1 } })).toEqual([
      { at: '2026-09-29T07:00:00.000Z', temperature: null, cloudCover: 40, precipitation: null, irradiance: null },
    ]);
    answer = [{ cloudCover: 40 }];
    expect(reader.query({ part: 'main', capability: 'weather.forecast', query: 'hourly', args: {} })).rejects.toThrow('its answer [0].at must be given');
    expect(reader.query({ part: 'main', capability: 'weather.forecast', query: 'hourly', args: { hours: 500 } })).rejects.toThrow('hours must be at most 168');
  });

  test('has nothing that acts', () => {
    const reader = deviceReader(session({}), () => description);
    expect(Object.keys(reader).sort()).toEqual(['health', 'query', 'readings']);
  });
});
