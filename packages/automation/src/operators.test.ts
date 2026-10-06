import { describe, expect, test } from 'bun:test';

import type { Unit, Value } from '@kraftverk/device-sdk';

import { checkBinding, checkRule } from './check.ts';
import { describeExpr } from './describe.ts';
import { evaluateNow, inlineParams, measureNow, settledScope, type RuleScope } from './evaluate.ts';
import type { Expr, Rule } from './rule.ts';
import { parseExpr, printExpr } from './text/expr.ts';

/*
  The expression language's operators and functions: products and quotients
  with the units they make, the language's own functions, one value or the
  other, the first known, one of a list, a number's opposite — each read
  from its text, written back as it was, evaluated with its units, held to
  them before it runs, and said in words.
*/

const parse = (text: string): Expr => {
  const parsed = parseExpr(text);
  if (!parsed.ok) throw new Error(`${text}: ${parsed.error.message}`);
  return parsed.expr;
};

/** What the parts report: a station's charge, capacity and mode, a charger's power, an outdoor temperature not known. */
const readings: Record<string, { value: Value; unit: Unit | null }> = {
  'station.charge': { value: 40, unit: '%' },
  'station.capacity': { value: 2, unit: 'kWh' },
  'station.mode': { value: 'eco', unit: null },
  'charger.power': { value: 1500, unit: 'W' },
  'price.priceRank': { value: 3, unit: null },
};
const scope: RuleScope = {
  param: () => ({ value: null, unit: null }),
  read: (role, means) => {
    const found = readings[`${role}.${means}`];
    return found ? { value: found.value as never, label: means, unit: found.unit } : null;
  },
  reachable: () => ({ reachable: true, detail: '' }),
  name: (role) => (role === 'station' ? 'Garage P280' : role === 'charger' ? 'the charger' : role),
  clock: () => null,
};
const measured = (text: string) => measureNow(parse(text), scope);
const value = (text: string) => evaluateNow(parse(text), scope);

describe('read and written back as they were', () => {
  for (const text of [
    'station.capacity * 50 %',
    'charger.power * 2 h',
    'station.capacity / 2',
    'a.b - (c.d - 1)',
    'a.b / (c.d * 2)',
    '-meter.power',
    '-(5)',
    'a.b - -5',
    'min(a.b, 80 %, c.d)',
    'clamp(charger.power, 0 W, 2 kW)',
    'round(station.charge, 1)',
    'price.priceRank <= 4 ? 2 kW : 500 W',
    'outdoor.temperature ?? 10 °C',
    'station.mode in ["eco", "boost"]',
    'setting.low',
    'acme.weather.sunny(forecast, day = "tomorrow")',
    'a.b < 5 ? c.d ?? 1 : 2',
  ]) {
    test(text, () => {
      const expr = parse(text);
      expect(printExpr(expr)).toBe(text);
      expect(parse(printExpr(expr)!)).toEqual(expr);
    });
  }

  test('a function is the language’s or a package’s, by its whole id; the old ways of writing them are no more', () => {
    expect(parseExpr('average(a.b, c.d)')).toMatchObject({ ok: false, error: { message: expect.stringContaining('"average" is not a function') } });
    expect(parseExpr('$low').ok).toBe(false);
    expect(parseExpr('call acme.weather.sunny(forecast)').ok).toBe(false);
  });
});

describe('evaluated with their units', () => {
  test('a percentage of something is a share of it; a power for a time an energy; an energy over a time a power', () => {
    expect(measured('station.capacity * 50 %')).toEqual({ value: 1, unit: 'kWh' });
    expect(measured('charger.power * 2 h')).toEqual({ value: 3000, unit: 'Wh' });
    expect(value('charger.power * 2 h > 2.5 kWh')).toBe(true);
    expect(measured('station.capacity / 2 h')).toEqual({ value: 1000, unit: 'W' });
    expect(measured('charger.power / 500 W')).toEqual({ value: 3, unit: null });
    expect(measured('station.capacity / 2')).toEqual({ value: 1, unit: 'kWh' });
    // By nothing is no number.
    expect(value('station.capacity / 0')).toBeNull();
  });

  test('the language’s functions, in the first one’s unit', () => {
    expect(measured('clamp(charger.power, 0 W, 1 kW)')).toEqual({ value: 1000, unit: 'W' });
    expect(measured('min(station.charge, 80 %)')).toEqual({ value: 40, unit: '%' });
    expect(measured('max(2 kW, charger.power)')).toEqual({ value: 2, unit: 'kW' });
    expect(measured('round(charger.power / 7 W, 2)')).toEqual({ value: 214.29, unit: null });
    expect(value('abs(-meter.power)')).toBeNull();
  });

  test('one or the other, as the condition holds; the first known; one of a list; the opposite', () => {
    expect(measured('price.priceRank <= 4 ? 2 kW : 500 W')).toEqual({ value: 2, unit: 'kW' });
    expect(measured('outdoor.temperature ?? 10 °C')).toEqual({ value: 10, unit: '°C' });
    expect(value('station.mode in ["eco", "boost"]')).toBe(true);
    expect(value('station.mode in ["boost"]')).toBe(false);
    expect(value('outdoor.mode in ["boost"]')).toBeNull();
    expect(value('charger.power in [1 kW, 1.5 kW]')).toBe(true);
    expect(measured('-charger.power')).toEqual({ value: -1500, unit: 'W' });
    // Unknown whether it holds: unknown which.
    expect(value('outdoor.temperature > 5 °C ? 1 : 2')).toBeNull();
  });
});

describe('held to their units before they run', () => {
  const roles: Rule['roles'] = {
    station: { label: 'Station', capabilities: ['battery'] },
    charger: { label: 'Charger', capabilities: ['switch', 'powerMeter'] },
  };
  const problems = (text: string) => checkRule({ roles, params: { fields: {} }, when: [], then: [{ command: { role: 'charger', capability: 'switch', command: 'set', args: { on: parse(text) } } }] }, { fn: () => null });

  test('what the units make, compared as that', () => {
    expect(problems('charger.power * 2 h > 2 kWh')).toEqual([]);
    expect(problems('charger.power * 2 h > 2 kW')).toEqual(['then[0].command.args.on: compares a number in Wh with a number in kW']);
    expect(problems('charger.power * station.charge > 1 W')).toEqual([]);
    expect(problems('charger.power * 2 °C > 1 W')).toEqual(['then[0].command.args.on.left: a number in W times a number in °C makes no unit kraftverk knows']);
  });

  test('a function’s arguments, its count and units', () => {
    expect(problems('min(station.charge, 80 %) < 50 %')).toEqual([]);
    expect(problems('min(station.charge, 2 kW) < 50 %')).toEqual(['then[0].command.args.on.left.args[1]: expected a number in %, got a number in kW']);
    expect(problems('clamp(station.charge, 10 %) < 50 %')).toEqual(['then[0].command.args.on.left: clamp takes 3 numbers']);
    expect(problems('round(station.charge, 1 %) < 50 %')).toEqual(['then[0].command.args.on.left.args[1]: a plain number, got a number in %']);
  });

  test('one or the other is the same kind either way; one of a list, of its kind', () => {
    expect(problems('(station.charge < 20 % ? 2 kW : 500 W) > charger.power')).toEqual([]);
    expect(problems('(station.charge < 20 % ? 2 kW : 50 %) > charger.power')).toEqual(['then[0].command.args.on.left: one way a number in kW, the other a number in %']);
    expect(problems('charger.power in [1 kW, 50 %]')).toEqual(['then[0].command.args.on.in[1]: expected a number in W, got a number in %']);
  });
});

describe('said in words', () => {
  const rule: Rule = { roles: {}, params: { fields: {} }, when: [], then: [] };
  const words = (text: string) => describeExpr(rule, parse(text), {}, scope.name);

  test('as a person says them', () => {
    expect(words('station.capacity * 50 % > 1 kWh')).toBe('50 % of Garage P280’s capacity is above 1 kWh');
    expect(words('clamp(charger.power, 0 W, 2 kW) > 1 kW')).toBe('the charger’s power, kept between 0 W and 2 kW is above 1 kW');
    expect(words('station.mode in ["eco", "boost"]')).toBe('Garage P280’s mode is eco or boost');
    expect(words('outdoor.temperature ?? 10 °C')).toBe('outdoor’s temperature — or, when that is not known, 10 °C');
  });
});

describe('a recipe’s settings written in', () => {
  test('a setting is a number in its own unit: one kept in W, beside kW, is converted — not taken for kW', () => {
    const rule: Rule = { roles: {}, params: { fields: { power: { type: 'number', title: 'Power', unit: 'W', default: 1500 } } }, when: [], then: [] };
    const scope = settledScope(rule, {});
    expect(evaluateNow(parse('setting.power > 1 kW'), scope)).toBe(true);
    expect(evaluateNow(parse('setting.power > 2 kW'), scope)).toBe(false);
    expect(measureNow(parse('setting.power'), scope)).toEqual({ value: 1500, unit: 'W' });
  });

  test('what the settings alone decide is decided, in its unit', () => {
    const recipe: Rule = {
      roles: { charger: { label: 'Charger', capabilities: ['switch', 'powerMeter'] } },
      params: { fields: { fast: { type: 'boolean', title: 'Fast', default: true }, low: { type: 'number', title: 'Low', unit: 'W', default: 200 } } },
      when: [],
      then: [{ command: { role: 'charger', capability: 'switch', command: 'set', args: { on: parse('charger.power > (setting.fast ? max(setting.low, 1 kW) : setting.low)') } } }],
    };
    expect(inlineParams(recipe, {}).then).toEqual([{ command: { role: 'charger', capability: 'switch', command: 'set', args: { on: { compare: 'gt', left: { read: { role: 'charger', means: 'power' } }, right: { value: 1000, unit: 'W' } } } } }]);
  });
});

describe('what the event that started it carried', () => {
  const roles: Rule['roles'] = { station: { label: 'Mains', capabilities: ['acInput'] }, plug: { label: 'Plug', capabilities: ['switch'] } };
  const rule = (on: string, when: Rule['when'] = [{ event: { role: 'station', event: 'mains.lost' } }]): Rule => ({
    roles,
    params: { fields: {} },
    when,
    then: [{ command: { role: 'plug', capability: 'switch', command: 'set', args: { on: parse(on) } } }],
  });

  test('read as run.event and run.event.voltage, and written back so', () => {
    expect(parse('run.event.voltage > 200 V')).toEqual({ compare: 'gt', left: { run: 'event', field: 'voltage' }, right: { value: 200, unit: 'V' } });
    for (const text of ['run.event == "mains.lost"', 'run.event.voltage > 200 V']) expect(printExpr(parse(text))).toBe(text);
    expect(parseExpr('run.trigger.voltage').ok).toBe(false);
  });

  test('checked: only where an event may start it, of the events it waits for, and only in what it does', () => {
    expect(checkRule(rule('run.event.voltage > 200 V'), { fn: () => null })).toEqual([]);
    expect(checkRule(rule('run.event == "mains.lost"'), { fn: () => null })).toEqual([]);
    expect(checkRule(rule('run.event == "button.pressed"'), { fn: () => null })).toEqual(['then[0].command.args.on: "button.pressed" is not one of mains.lost']);
    expect(checkRule(rule('run.event.voltage > 200 V', [{ at: { value: '07:00' } }]), { fn: () => null })).toEqual([
      'then[0].command.args.on.left: run.event.voltage is what an event that started it says, but nothing it waits for is an event',
    ]);
  });

  test('once bound, something the part’s event declares it carries', () => {
    const station = (data?: Record<string, unknown>) => ({
      name: 'Garage station',
      part: 'input.ac',
      capabilities: ['acInput'],
      description: { parts: [{ id: 'input.ac', label: 'Mains', kind: 'input', offers: ['acInput'] }], attributes: [], events: [{ id: 'mains.lost', label: 'Mains lost', level: 'warn', part: 'input.ac', ...(data ? { data } : {}) }] },
    });
    const plug = { name: 'Plug', part: 'main', capabilities: ['switch'], description: { parts: [{ id: 'main', label: 'Plug', kind: 'outlet', offers: ['switch'] }], attributes: [{ key: 'on', label: 'On', value: { type: 'boolean' }, means: 'on' }] } };
    const bound = (data?: Record<string, unknown>) => (role: string) => (role === 'station' ? station(data) : plug) as never;
    expect(checkBinding(rule('run.event.voltage > 200 V'), bound({ voltage: { type: 'number', unit: 'V' } }))).toEqual([]);
    expect(checkBinding(rule('run.event.voltage > 200 V'), bound())).toEqual(['run.event.voltage: none of the events it waits for carries "voltage"']);
  });

  test('said as what the device reported', () => {
    expect(describeExpr(rule('true'), parse('run.event.voltage > 200 V'), {}, (role) => role)).toBe('the voltage it reported is above 200 V');
  });
});
