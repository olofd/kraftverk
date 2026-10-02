import { describe, expect, test } from 'bun:test';

import { SCHEMA, schemaFingerprint, type SqlDatabase } from '../src/index.ts';
import { DRIVERS } from './drivers.ts';

/*
  The one schema every node carries (strict version 1, docs/ARCHITECTURE.md
  §9): what its fingerprint covers — what a table is, not how it is
  explained — and what its tables hold themselves, on each SQLite a home is
  kept in.
*/

describe('the schema', () => {
  test('rewording a comment is not a new schema; changing a column is', () => {
    const comment = "/* Each device's own storage: what its session keeps between runs. */";
    expect(SCHEMA).toContain(comment);
    expect(schemaFingerprint(SCHEMA.replace(comment, '/* What a device keeps. */'))).toBe(schemaFingerprint(SCHEMA));
    expect(SCHEMA).toContain('summary       TEXT NOT NULL,');
    expect(schemaFingerprint(SCHEMA.replace('summary       TEXT NOT NULL,', 'summary       TEXT,'))).not.toBe(schemaFingerprint(SCHEMA));
  });

  for (const driver of DRIVERS) {
    test(`a sample holds a number or text, never both and never neither (${driver.name})`, async () => {
      const handle: SqlDatabase = await driver.open();
      handle.query("INSERT INTO device (id, key, type_id, name, description, added_at) VALUES ('d-1', 'd-1', 'test.lamp', 'Lamp', '{\"attributes\":[]}', '2026-09-29T00:00:00Z')").run();
      const insert = handle.query("INSERT INTO sample (device_id, part, key, at, value, text) VALUES (?, 'main', ?, ?, ?, ?)");
      insert.run('d-1', 'soc', '2026-09-29T00:00:00Z', 80, null);
      insert.run('d-1', 'state', '2026-09-29T00:00:00Z', null, 'charging');
      expect(() => insert.run('d-1', 'both', '2026-09-29T00:00:00Z', 1, 'one')).toThrow();
      expect(() => insert.run('d-1', 'neither', '2026-09-29T00:00:00Z', null, null)).toThrow();
      handle.close();
    });
  }
});
