import { describe, expect, test } from 'bun:test';
import Ajv from 'ajv';

import { configJsonSchema, entryJsonSchema } from './schema.ts';
import { DOCUMENT, VOCABULARY } from './testing.ts';
import { parseDocument } from 'yaml';
import { secretTag } from './yaml.ts';

/*
  The JSON Schema an editor checks a file against as it is typed: it takes a
  whole charging chain, and it says what is missing or wrong — a required
  secret, a setting the type has not, a step with words of another.
*/

const ajv = new Ajv({ strict: false, allErrors: true });
const asData = (text: string) => JSON.parse(JSON.stringify(parseDocument(text, { customTags: [secretTag] }).toJS(), (_key, value) => (value && typeof value === 'object' && 'name' in value && Object.keys(value).length === 1 ? `!secret ${value.name}` : value)));
const valid = (schema: Record<string, unknown>, data: unknown) => {
  const check = ajv.compile(schema);
  return check(data) ? [] : (check.errors ?? []).map((error) => `${error.instancePath} ${error.message}`);
};

describe('the schema a file is checked against as it is typed', () => {
  const schema = configJsonSchema(VOCABULARY);

  test('a whole charging chain is what it allows', () => {
    expect(valid(schema, asData(DOCUMENT))).toEqual([]);
  });

  test('a plug reached on the home network without its local key, or a device id, is not', () => {
    const data = asData(DOCUMENT);
    delete data.devices['smart-plug'].connect[0].secrets;
    delete data.devices['smart-plug'].connect[0].settings.deviceId;
    const errors = valid(schema, data);
    expect(errors).toContain("/devices/smart-plug/connect/0 must have required property 'secrets'");
    expect(errors).toContain("/devices/smart-plug/connect/0/settings must have required property 'deviceId'");
  });

  test('a type it does not know, a setting its type has not, a way it is not reached', () => {
    const data = asData(DOCUMENT);
    data.devices['garage-station'].settings = { colour: 'red' };
    data.devices['ac-in-meter'].connect[0].via = 'carrier-pigeon';
    data.devices.mystery = { type: 'acme.nothing', name: 'Mystery' };
    const errors = valid(schema, data);
    expect(errors).toContain('/devices/garage-station/settings must NOT have additional properties');
    expect(errors).toContain('/devices/ac-in-meter/connect/0/via must be equal to one of the allowed values');
    expect(errors).toContain('/devices/mystery/type must be equal to one of the allowed values');
  });

  test('a step with words of another, and a wait with no limit', () => {
    const data = asData(DOCUMENT);
    data.automations['start-charging'].do.push({ 'turn on': 'charger', within: '5 s' }, { 'wait until': 'charger reachable' });
    expect(valid(schema, data).length).toBeGreaterThan(0);
  });

  test('one automation’s own schema, as its page edits it', () => {
    const data = asData(DOCUMENT).automations['start-charging'];
    expect(valid(entryJsonSchema(VOCABULARY, 'automation'), data)).toEqual([]);
    expect(valid(entryJsonSchema(VOCABULARY, 'automation'), { ...data, mode: 'sometimes' })).toContain('/mode must be equal to one of the allowed values');
  });
});
