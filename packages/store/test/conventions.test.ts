import { describe, expect, test } from 'bun:test';

import { ACTOR_KINDS } from '@kraftverk/device-sdk';

import { SCHEMA } from '../src/index.ts';

/*
  The rules every table keeps (docs/PLAN-WORLD-MODEL.md §6), held by reading
  the one schema: so a table added later keeps them too, or says why not
  here. Comments are taken out first; what is left is each table's columns
  and checks.
*/

const sql = SCHEMA.replace(/\/\*[\s\S]*?\*\//g, '');
const tables = [...sql.matchAll(/CREATE TABLE (\w+) \(([\s\S]*?)\n {2}\);/g)].map(([, name, body]) => ({ name: name!, body: body! }));
const columns = (body: string) =>
  body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[a-z_]+\s+(TEXT|INTEGER|REAL|BLOB)\b/.test(line))
    .map((line) => ({ name: line.split(/\s+/)[0]!, line }));

describe('every table', () => {
  test('is found', () => {
    expect(tables.map((table) => table.name)).toEqual(expect.arrayContaining(['family', 'place', 'home', 'device', 'audit', 'media']));
  });

  test('says who did something as an actor — its kind among the kinds, an id, a name — never as free text', () => {
    const kinds = `(${ACTOR_KINDS.map((kind) => `'${kind}'`).join(', ')})`;
    for (const { name, body } of tables) {
      for (const column of columns(body)) {
        // A kind of actor lists every kind there is, and no other.
        if (/(^|_)(actor|by)_kind$|^started_by_kind$/.test(column.name)) expect(column.line, `${name}.${column.name}`).toContain(`IN ${kinds}`);
        // Who did it is a reference, or part of an actor: never a column of its own text.
        if (/_by$/.test(column.name)) expect(column.line, `${name}.${column.name}: who did it is an actor, or a reference`).toMatch(/REFERENCES/);
      }
    }
  });

  test('keeps an instant as text, and an interval that ends after it starts', () => {
    for (const { name, body } of tables) {
      const own = columns(body);
      for (const column of own) if (/_at$/.test(column.name)) expect(column.line, `${name}.${column.name}`).toMatch(/^\w+\s+TEXT\b/);
      const names = new Set(own.map((column) => column.name));
      if (names.has('since') && names.has('until')) expect(body, `${name}: its until after its since`).toContain('CHECK (until IS NULL OR until > since)');
    }
  });
});
