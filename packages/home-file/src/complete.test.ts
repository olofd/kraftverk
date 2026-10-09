import { describe, expect, test } from 'bun:test';

import type { ScriptShape } from '@kraftverk/automation';

import { keysOffered } from './complete.ts';
import { entryJsonSchema } from './schema.ts';
import { vocabularyOf } from './vocabulary.ts';

/*
  What an editor offers where a map is not yet begun: the keys the schema
  takes there, as what is written chooses — a script's step its inputs.
*/

const TIDY: ScriptShape = {
  steps: {
    tidyUp: { about: 'Tidies.', inputs: { fields: { after: { type: 'number', title: 'Empty for at least', unit: 's', min: 60, default: 600 } } }, answer: null, memory: { fields: {} } },
    sweep: { about: null, inputs: { fields: { rooms: { type: 'number', title: 'Rooms', integer: true } } }, answer: null, memory: { fields: {} } },
  },
  functions: {},
};

const schema = entryJsonSchema({ ...vocabularyOf([], () => null), scripts: [{ id: 'sc-1', key: 'tidy-up', name: 'Tidy up', shape: TIDY }] }, 'automation');

describe('the keys a map not yet begun may take', () => {
  test('under a script step’s with: that step’s inputs — each with its title and default — chosen by what run script names', () => {
    const offered = keysOffered(schema, '/do/0/with', { name: 'T', do: [{ 'run script': 'tidy-up.tidyUp', with: null }] });
    expect(offered).toEqual([{ name: 'after', title: 'Empty for at least', description: 'Empty for at least: a length of time, from 1 min, by default 10 min', fallback: '10 min' }]);
    expect(keysOffered(schema, '/do/0/with', { name: 'T', do: [{ 'run script': 'tidy-up.sweep', with: 'r' }] }).map((each) => each.name)).toEqual(['rooms']);
  });

  test('a step’s own keys, whatever kind it is to be; and nothing where nothing is taken', () => {
    expect(keysOffered(schema, '/do/0', { name: 'T', do: [{ 'run script': 'tidy-up.tidyUp' }] }).map((each) => each.name)).toEqual(['run script', 'with', 'step', 'remember as']);
    expect(keysOffered(schema, '/name', { name: 'T' })).toEqual([]);
  });
});
