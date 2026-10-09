import { describe, expect, test } from 'bun:test';
import { parse } from 'yaml';
import { BUILT_IN_MODES } from '@kraftverk/device-sdk';

import { checkRule } from './check.ts';
import { describeRule, describeTriggers } from './describe.ts';
import { evaluateNow, type RuleScope } from './evaluate.ts';
import { edgeOf } from './kinds/triggers.ts';
import { parseMessage, sayMessage } from './message.ts';
import { ruleUses } from './reads.ts';
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
    expect(checkRule(without, NO_FUNCTIONS)).toEqual(['then[0].notify.title{0}: run.who is who arriving or leaving started it, but nothing that starts it is someone arriving or leaving']);
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
