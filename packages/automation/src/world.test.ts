import { describe, expect, test } from 'bun:test';
import { parse } from 'yaml';
import { BUILT_IN_MODES } from '@kraftverk/device-sdk';

import { checkRule } from './check.ts';
import { describeRule, describeTriggers } from './describe.ts';
import { roleName } from './draft.ts';
import { evaluateNow, inlineParams, type RuleScope } from './evaluate.ts';
import { edgeOf } from './kinds/triggers.ts';
import { mapMessage, parseMessage, sayMessage } from './message.ts';
import { keepsSo, placeKindsOf, ruleUses } from './reads.ts';
import type { Rule } from './rule.ts';
import { parseExpr, printExpr } from './text/expr.ts';
import { ruleFromConfig, ruleToConfig } from './text/rules.ts';

/*
  The family's world in the language: roles a person, people and a place
  fill; who is where, how many are home, a room's occupancy and a home's
  mode as values; what starts a run when someone comes or goes; and the
  steps that set a mode and tell people something.
*/

const NO_FUNCTIONS = { fn: () => null };

/** An automation's entry, its roles filled by made-up keys. */
const entry = (body: Record<string, unknown>) => ({
  uses: { olof: { person: 'olof' }, children: { people: ['anna', 'ben'] }, family: { people: 'everyone' }, work: { zone: 'work' }, bathroom: { space: 'bathroom' }, fan: { part: 'bathroom-fan', needs: ['switch'] } },
  ...body,
});
const read = (body: Record<string, unknown>) => {
  const got = ruleFromConfig(entry(body), []);
  expect(got.issues).toEqual([]);
  return { rule: got.rule as Rule, uses: got.uses };
};

describe('who is where, as text', () => {
  test('a person at a place, a place’s facts — read and written back the same', () => {
    for (const text of ['olof at home', 'not olof at work', 'home.people == 0', 'bathroom.occupied', 'home.presence == "away"', 'any(p in children: p at home)', 'count(p in children: p at work) > 1']) {
      const parsed = parseExpr(text);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(printExpr(parsed.expr)).toBe(text);
    }
    expect(parseExpr('olof at home')).toEqual({ ok: true, expr: { presentAt: { who: 'olof', place: 'home' } } });
    expect(parseExpr('home.people')).toEqual({ ok: true, expr: { read: { role: 'home', means: 'people' } } });
    const wrong = parseExpr('olof at 5');
    expect(wrong.ok ? null : wrong.error.message).toBe('Expected a place after "olof at": home, or a role a place fills');
  });
});

describe('who is where, checked', () => {
  const rule = (condition: string) => read({ when: [{ 'mode becomes': 'away' }], 'only if': condition, do: [{ 'turn off': 'fan' }] }).rule;
  test('a person at a place, a place’s facts, of each of several people: all of them sound', () => {
    for (const condition of ['olof at work', 'home.people == 0', 'bathroom.occupied', 'home.day == "night"', 'all(p in children: p at home)']) expect(checkRule(rule(condition), NO_FUNCTIONS)).toEqual([]);
  });

  test('what is not: people at a place as one, a person’s reading, a part at a place, a fact no place has', () => {
    expect(checkRule(rule('children at home'), NO_FUNCTIONS)).toEqual(['if.presentAt.who: children is people, not a person — say it of each: any(p in children: p at home)']);
    expect(checkRule(rule('olof.charge > 5 %'), NO_FUNCTIONS)).toEqual(['if.left: olof is a person: ask where with "at" — olof at home']);
    expect(checkRule(rule('fan at home'), NO_FUNCTIONS)).toEqual(['if.presentAt.who: fan is one part, not a person']);
    expect(checkRule(rule('olof at fan'), NO_FUNCTIONS)).toEqual(['if.presentAt.place: fan is one part, not a place']);
    expect(checkRule(rule('home.temperature > 20 °C'), NO_FUNCTIONS)).toEqual(['if.left: of a place, ask its people, occupied, presence, day — not "temperature"']);
    expect(checkRule(rule('home.presence == "gone"'), { ...NO_FUNCTIONS, modes: () => BUILT_IN_MODES.filter((mode) => mode.axis === 'presence') })).toEqual(['if: "gone" is not one of home, away, vacation']);
  });
});

describe('what starts it, and what it does', () => {
  test('“when the last one leaves, set away; when the first comes back, home” — read, checked, said, written back', () => {
    const body = { when: [{ 'last leaves': 'home', do: [{ 'set mode': 'away' }] }, { 'first arrives': 'home', do: [{ 'set mode': 'home' }] }], do: [] };
    const { rule, uses } = read(body);
    expect(rule.when.map((trigger) => Object.keys(trigger)[0])).toEqual(['lastLeaves', 'firstArrives']);
    expect(checkRule(rule, NO_FUNCTIONS)).toEqual([]);
    expect(describeTriggers(rule, {}, (role) => role)).toEqual(['When the last of the family leaves home', 'When the first of the family arrives home']);
    expect(ruleToConfig(rule, uses).when).toEqual(body.when);
    expect(ruleUses(rule).world).toBe(true);
  });

  test('the first and the last are conditions turning true: of the family by how many are there, of some by each of them', () => {
    expect(edgeOf({ lastLeaves: { at: 'home' } })).toEqual({ condition: { not: { compare: 'gt', left: { read: { role: 'home', means: 'people' } }, right: { value: 0 } } } });
    expect(edgeOf({ firstArrives: { at: 'work', of: 'children' } })).toEqual({ condition: { across: 'any', as: 'eachOfThem', group: 'children', of: { presentAt: { who: 'eachOfThem', place: 'work' } } } });
    expect(edgeOf({ empties: { place: 'bathroom', heldFor: { value: 600, unit: 's' } } })).toEqual({ condition: { not: { read: { role: 'bathroom', means: 'occupied' } } }, heldFor: { value: 600, unit: 's' } });
    expect(edgeOf({ arrives: { who: 'someone', at: 'home' } })).toBeNull();
  });

  test('someone arriving, a room empty, a mode: each its sentence; run.who only where someone arriving starts it', () => {
    const { rule } = read({
      when: [{ arrives: 'olof', at: 'work' }, { leaves: 'someone', at: 'home' }, { empties: 'bathroom', for: '10 min' }, { 'mode changes': 'day' }],
      do: [{ notify: 'family', title: '{run.who} came or went', level: 'info' }],
    });
    expect(checkRule(rule, NO_FUNCTIONS)).toEqual([]);
    expect(describeTriggers(rule, {}, (role) => (role === 'olof' ? 'Olof' : role === 'work' ? 'Work' : role))).toEqual([
      'When Olof arrives at Work',
      'When someone leaves home',
      'When nobody has been in bathroom for 10 min',
      'When the home’s time of day changes',
    ]);
    const without = read({ when: [{ 'mode becomes': 'night' }], do: [{ notify: 'olof', title: '{run.who} is here' }] }).rule;
    expect(checkRule(without, NO_FUNCTIONS)).toEqual(['then[0].notify.title{1}: run.who is who arriving or leaving started it, but nothing that starts this is someone arriving or leaving']);
  });

  test('set mode and notify: checked as their fields hold, said in words', () => {
    const { rule } = read({ when: [{ 'last leaves': 'home' }], do: [{ 'set mode': 'away' }, { notify: 'everyone', title: 'Nobody is home: {home.people} there', level: 'warning' }] });
    expect(checkRule(rule, NO_FUNCTIONS)).toEqual([]);
    expect(describeRule(rule, {}, (role) => role)).toBe('When the last of the family leaves home, set the home to away, then tell everyone “Nobody is home: {how many of the family are at home} there”.');
    const bad = read({ when: [{ 'last leaves': 'home' }], do: [{ 'set mode': 'Away!' }, { notify: 'fan', title: 'Hello {fan.' }] }).rule;
    expect(checkRule(bad, { ...NO_FUNCTIONS, modes: () => BUILT_IN_MODES.slice(0, 2) })).toEqual([
      'then[0].setMode.mode: a mode, by its key: home, away, vacation, day, evening, night, or one of the family\'s own',
      'then[1].notify.to: fan is one part, not a person, or people',
      'then[1].notify.title: A "{" is not closed: it needs its "}"',
    ]);
  });
});

describe('a message', () => {
  test('words, and values in braces; a brace itself doubled', () => {
    const parsed = parseMessage('The charge is {station.charge}, {{that}} is all');
    expect(parsed).toEqual({ ok: true, pieces: [{ text: 'The charge is ' }, { expr: { read: { role: 'station', means: 'charge' } }, source: 'station.charge' }, { text: ', {that} is all' }] });
    expect(sayMessage('{olof at home}!', () => 'yes')).toBe('yes!');
  });
});

describe('who is where, evaluated', () => {
  test('a person at a place by the scope; of each of several; a place’s facts as readings', () => {
    const scope: RuleScope = {
      param: () => ({ value: null, unit: null }),
      read: (role, means) => (role === 'home' && means === 'people' ? { value: 2, label: 'People', unit: null } : null),
      reachable: () => ({ reachable: true, detail: '' }),
      name: (role) => role,
      clock: () => null,
      presentAt: (who, place) => (place === 'home' ? who !== 'ben' : null),
      members: (group, as) => (group === 'children' ? ['anna', 'ben'].map((person) => ({ ...scope, presentAt: (who: string, place: string) => scope.presentAt!(who === as ? person : who, place) })) : null),
    };
    const value = (text: string) => {
      const parsed = parseExpr(text);
      return parsed.ok ? evaluateNow(parsed.expr, scope) : 'not an expression';
    };
    expect(value('olof at home')).toBe(true);
    expect(value('ben at home')).toBe(false);
    expect(value('olof at work')).toBeNull();
    expect(value('all(p in children: p at home)')).toBe(false);
    expect(value('count(p in children: p at home)')).toBe(1);
    expect(value('home.people > 1')).toBe(true);
  });

  test('a file’s roles of people and places: read as their kinds, written back the same', () => {
    const body = { when: [{ arrives: 'children', at: 'work' }], do: [{ notify: 'family', title: 'Hi' }] };
    const got = ruleFromConfig(entry(body), []);
    expect(got.rule!.roles.olof).toEqual({ person: true, label: 'Olof' });
    expect(got.rule!.roles.children).toEqual({ people: true, label: 'Children' });
    expect(got.rule!.roles.work).toEqual({ place: true, label: 'Work' });
    expect(got.uses).toMatchObject({ olof: { person: 'olof' }, children: { people: ['anna', 'ben'] }, family: { everyone: true }, work: { zone: 'work' }, bathroom: { space: 'bathroom' } });
    const written = ruleToConfig(got.rule!, got.uses);
    expect(written.uses).toMatchObject({ olof: { person: 'olof' }, children: { people: ['anna', 'ben'] }, family: { people: 'everyone' }, work: { zone: 'work' }, bathroom: { space: 'bathroom' } });
    expect(parse(JSON.stringify(written.when))).toEqual(body.when);
  });
});

describe('the review, held to', () => {
  test('values in a message are settled with the settings, and read as each part of a group', () => {
    const recipe: Rule = {
      roles: { chargers: { label: 'Chargers', capabilities: ['switch', 'powerMeter'], group: true }, family: { people: true, label: 'Family' } },
      params: { fields: { low: { type: 'number', title: 'Low', unit: 'W', min: 0, max: 100, default: 5 } } },
      when: [{ at: { value: '07:00' } }],
      then: [{ forEach: { as: 'charger', in: 'chargers', steps: [{ notify: { to: 'family', title: 'Below {setting.low}: {charger.power}' } }] } }],
    };
    const copied = inlineParams(recipe, {});
    expect(JSON.stringify(copied.then)).toContain('Below {5 W}: {charger.power}');
    expect(checkRule({ ...copied, params: { fields: {} } }, NO_FUNCTIONS)).toEqual([]);
    expect(ruleUses(recipe).reads).toEqual([{ role: 'chargers', means: 'power' }]);
  });

  test('a message: a brace within quotes is the value’s, one alone is a mistake, and where it goes wrong is where it is', () => {
    expect(parseMessage('Started by {run.trigger == "}"}')).toMatchObject({ ok: true });
    expect(parseMessage('a } b')).toEqual({ ok: false, error: { message: 'A "}" alone: write "}}" for one in the words', offset: 2 } });
    const wrong = parseMessage('a {  station.  } b');
    expect(wrong.ok ? null : wrong.error.offset).toBe(13);
    expect(mapMessage('{{x}} is {setting.low}', () => ({ value: 5, unit: 'W' }))).toBe('{{x}} is {5 W}');
  });

  test('a role is never named as a word of the language: a home called Home is not the automation’s own', () => {
    const rule: Rule = { roles: {}, params: { fields: {} }, when: [], then: [] };
    expect(roleName(rule, 'Home')).toBe('home2');
    expect(roleName(rule, 'Everyone')).toBe('everyone2');
  });

  test('a mode is a home’s: a role whose mode is waited for is a home', () => {
    const rule = read({ when: [{ 'mode becomes': 'away', at: 'work' }], do: [{ 'turn off': 'fan' }] }).rule;
    expect(placeKindsOf(rule, 'work')).toEqual(['home']);
    expect(placeKindsOf(rule, 'bathroom')).toEqual(['home', 'zone', 'space']);
  });

  test('how it was is kept of what parts report, not of a place', () => {
    const rule = read({ when: [{ 'mode becomes': 'away' }], 'only if': 'average(home.people, 1 h) > 1', do: [{ 'turn off': 'fan' }] }).rule;
    expect(checkRule(rule, NO_FUNCTIONS)).toEqual(['if.left: how it was is kept of what a part reports, not of a place or a person']);
    expect(ruleUses(rule).reads).toEqual([]);
  });

  test('telling people is not kept so: looking again would tell them again', () => {
    const turns = read({ when: [{ 'last leaves': 'home' }], do: [{ 'turn off': 'fan' }] }).rule;
    const tells = read({ when: [{ 'last leaves': 'home' }], do: [{ 'turn off': 'fan' }, { notify: 'family', title: 'Off' }] }).rule;
    expect([keepsSo(turns), keepsSo(tells)]).toEqual([true, false]);
  });

  test('run.who where someone arriving starts that very list: a trigger’s own steps, or the automation’s from those without', () => {
    const own = read({ when: [{ arrives: 'someone', at: 'home', do: [{ notify: 'family', title: '{run.who}' }] }, { 'mode becomes': 'night', do: [{ notify: 'family', title: '{run.who}' }] }] }).rule;
    expect(checkRule(own, NO_FUNCTIONS)).toEqual(['when[1].then[0].notify.title{1}: run.who is who arriving or leaving started it, but nothing that starts this is someone arriving or leaving']);
  });

  test('in words: one of several arriving; the home as a place; the last, and how long nobody is back', () => {
    const rule = read({ when: [{ arrives: 'children', at: 'home' }, { arrives: 'family', at: 'home' }, { empties: 'home' }, { 'last leaves': 'home', for: '5 min' }], do: [{ 'turn off': 'fan' }] }).rule;
    expect(describeTriggers(rule, {}, (role) => (role === 'family' ? 'everyone' : role === 'children' ? 'Anna and Ben' : role))).toEqual([
      'When one of Anna and Ben arrives home',
      'When anyone in the family arrives home',
      'When nobody is in the home any more',
      'When the last of the family leaves home and nobody is back within 5 min',
    ]);
    expect(edgeOf(rule.when[3]!)?.heldFor).toEqual({ value: 5, unit: 'min' });
  });
});
