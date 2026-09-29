import { describe, expect, test } from 'bun:test';

import { schemaProblems, secretFields, validateConfig, withoutSecrets, type ConfigSchema } from './schema.ts';

const schema: ConfigSchema = {
  fields: {
    host: { type: 'string', presentation: 'host', title: 'Address', required: true },
    deviceId: { type: 'string', title: 'Device id', required: true },
    localKey: { type: 'string', presentation: 'secret', title: 'Local key', required: true },
    protocol: {
      type: 'enum',
      title: 'Protocol',
      default: '3.3',
      options: [
        { value: '3.3', label: '3.3' },
        { value: '3.4', label: '3.4' },
      ],
    },
    pollSeconds: { type: 'number', title: 'Poll', default: 10, min: 2, max: 600, integer: true },
    beep: { type: 'boolean', title: 'Beep' },
  },
};

describe('presentation', () => {
  test('a secret and a host are text, shown and kept their own way', () => {
    expect(secretFields(schema)).toEqual(['localKey']);
    const result = validateConfig(schema, { host: 'http://192.0.2.5/', deviceId: 'abc', localKey: 'k' });
    expect(result.ok ? [] : result.issues.map((issue) => issue.message)).toEqual(['Address must be a hostname or IP address']);
  });

  test('a presentation its type cannot have is named', () => {
    expect(schemaProblems('config', { fields: { n: { type: 'number', title: 'N', presentation: 'slider' } } })).toEqual(['config field "n" is a slider with no range']);
    expect(schemaProblems('config', { fields: { n: { type: 'number', title: 'N', presentation: 'secret' as never } } })).toEqual(['config field "n" is number, which cannot be presented as secret']);
    expect(schemaProblems('config', { fields: { n: { type: 'number', title: 'N', min: 0, max: 5, default: 9 } } })).toEqual(['config field "n" has a default its type does not allow']);
  });
});

describe('config validation', () => {
  test('applies defaults for anything not supplied', () => {
    const result = validateConfig(schema, { host: '192.168.1.5', deviceId: 'abc', localKey: 'k' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.protocol).toBe('3.3');
    expect(result.value.pollSeconds).toBe(10);
    expect(result.value.beep).toBe(false);
  });

  test('reports every problem at once, not just the first', () => {
    const result = validateConfig(schema, { pollSeconds: 1, protocol: '9.9' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const fields = result.issues.map((issue) => issue.field).sort();
    expect(fields).toEqual(['deviceId', 'host', 'localKey', 'pollSeconds', 'protocol']);
  });

  test('rejects a URL where a host is wanted', () => {
    // The mistake worth catching: pasting "http://192.168.1.5/" from a browser.
    const result = validateConfig(schema, {
      host: 'http://192.168.1.5/',
      deviceId: 'abc',
      localKey: 'k',
    });
    expect(result.ok).toBe(false);
  });

  test('rejects settings the plugin never declared', () => {
    const result = validateConfig(schema, {
      host: 'plug.local',
      deviceId: 'abc',
      localKey: 'k',
      sneaky: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.field).toBe('sneaky');
  });

  test('secrets are identified and strippable', () => {
    expect(secretFields(schema)).toEqual(['localKey']);
    expect(withoutSecrets(schema, { host: 'x', localKey: 'shhh' })).toEqual({ host: 'x' });
  });
});
