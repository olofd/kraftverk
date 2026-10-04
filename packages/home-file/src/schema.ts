import { stepJsonSchema, triggerJsonSchema } from '@kraftverk/automation';
import type { ConfigField, ConfigSchema } from '@kraftverk/device-sdk';

import { KEY } from '@kraftverk/device-sdk';
import { CURRENT_VERSION } from './migrate.ts';
import type { Vocabulary, VocabularyMethod, VocabularyType } from './vocabulary.ts';

/*
  The JSON Schema a configuration is checked against as it is typed
  (docs/CONFIG.md): made from the vocabulary — the installed types, each way
  each is reached, the keys the server has — so an editor completes a type,
  its settings and its secrets, flags a required field left out, and offers
  the devices there are. Draft-07, which the editors read: VS Code's YAML
  extension and the app's own. What a schema cannot say — what an expression
  means, whether a key names a device — the check (`check.ts`) says.
*/

type Schema = Record<string, unknown>;

/** A field of a type's or a method's settings, as JSON Schema says it. */
function fieldSchema(field: ConfigField): Schema {
  const common: Schema = { title: field.title, ...(field.description ? { description: field.description } : {}), ...('default' in field && field.default !== undefined ? { default: field.default } : {}) };
  switch (field.type) {
    case 'string':
      return { ...common, type: 'string' };
    case 'number':
      return {
        ...common,
        type: field.integer ? 'integer' : 'number',
        ...(field.min !== undefined ? { minimum: field.min } : {}),
        ...(field.max !== undefined ? { maximum: field.max } : {}),
        ...(field.unit ? { description: `${field.description ? `${field.description} ` : ''}In ${field.unit}.` } : {}),
      };
    case 'boolean':
      return { ...common, type: 'boolean' };
    case 'enum':
      return { ...common, enum: field.options.map((option) => option.value), enumDescriptions: field.options.map((option) => option.label) };
    case 'timestamp':
      return { ...common, type: 'string', format: 'date-time' };
  }
}

/** A type's or a method's settings: each field, the required ones without a default required. */
function settingsSchema(schema: ConfigSchema, what: string): Schema {
  const required = Object.entries(schema.fields)
    .filter(([, field]) => field.required && !('default' in field && field.default !== undefined))
    .map(([name]) => name);
  return {
    type: 'object',
    description: what,
    properties: Object.fromEntries(Object.entries(schema.fields).map(([name, field]) => [name, fieldSchema(field)])),
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  };
}

const SECRET_VALUE: Schema = {
  type: 'string',
  description: 'A secret: `!secret name` for one kept by name, a sealed value ("sealed:…"), or the text itself.',
};

function methodSchema(method: VocabularyMethod): Schema {
  const requiredSecrets = Object.entries(method.secrets.fields)
    .filter(([, field]) => field.required)
    .map(([name]) => name);
  const settingsRequired = Object.values(method.settings.fields).some((field) => field.required && !('default' in field && field.default !== undefined));
  return {
    if: { properties: { via: { const: method.id } }, required: ['via'] },
    then: {
      properties: {
        settings: settingsSchema(method.settings, `${method.label}: its settings`),
        secrets: {
          type: 'object',
          description: `${method.label}: its secrets`,
          properties: Object.fromEntries(Object.entries(method.secrets.fields).map(([name, field]) => [name, { ...SECRET_VALUE, title: field.title }])),
          ...(requiredSecrets.length ? { required: requiredSecrets } : {}),
          additionalProperties: false,
        },
      },
      required: [...(method.fixedAddress ? [] : ['address']), ...(settingsRequired ? ['settings'] : []), ...(requiredSecrets.length ? ['secrets'] : [])],
    },
  };
}

function deviceSchema(types: readonly VocabularyType[]): Schema {
  return {
    type: 'object',
    title: 'A device',
    required: ['type', 'name'],
    additionalProperties: false,
    properties: {
      type: { enum: types.map((type) => type.id), enumDescriptions: types.map((type) => type.name), description: 'Its device type.' },
      name: { type: 'string', minLength: 1, description: 'Its name, as the app shows it.' },
      identity: { type: 'string', description: 'Who the hardware says it is, as it said when added.' },
      picture: { type: 'string', pattern: '^(type:[0-9]+|own:.+)$', description: 'Which of its pictures it shows: "type:2".' },
      settings: { type: 'object', description: 'Its type’s settings.' },
      connect: {
        type: 'array',
        description: 'The ways it is reached, preferred first.',
        items: {
          type: 'object',
          required: ['via'],
          additionalProperties: false,
          properties: {
            via: { type: 'string' },
            address: { type: 'string' },
            settings: { type: 'object' },
            secrets: { type: 'object' },
            exportable: { type: 'boolean', description: 'Whether its secrets may leave in an export as plain text: off unless chosen, and warned against.' },
          },
        },
      },
    },
    allOf: types.map((type) => ({
      if: { properties: { type: { const: type.id } }, required: ['type'] },
      then: {
        properties: {
          settings: settingsSchema(type.settings, `${type.name}: its settings`),
          connect: {
            items: {
              properties: { via: { enum: type.methods.map((method) => method.id), enumDescriptions: type.methods.map((method) => method.label) } },
              allOf: type.methods.map(methodSchema),
            },
          },
        },
      },
    })),
  };
}

/** A length of time — "5 s", "2 min", "1 h" — or an expression for one. Never a bare number: it would say no unit. */
const DURATION: Schema = {
  anyOf: [{ type: 'string', pattern: '\\D', description: 'A length of time with its unit: "5 s", "2 min", "1 h" — or an expression.' }, { type: 'object' }],
};

/** A condition or value: an expression's text — or a plain value, or the rule's own data. */
const EXPRESSION: Schema = {
  anyOf: [
    {
      type: 'string',
      description:
        'An expression: a reading `role.meaning` ("charger.power.draw"), `role reachable`, `run.trigger` (the id of the trigger that started the run), numbers with units ("50 W"), times ("07:00"), "text", compared with < <= > >= == !=, joined with and, or, not; `time between 23:00 and 05:00`; min( , ), max( , ), + -; `call package.fn(role, name = value)`.',
    },
    { type: 'number' },
    { type: 'boolean' },
    { type: 'null' },
    { type: 'object' },
  ],
};

const STEPS: Schema = { type: 'array', items: { $ref: '#/$defs/step' } };

/** A step: made from the language's own description of each kind (@kraftverk/automation, kinds/) — its fields under its verb, or its own words' forms. */
const STEP: Schema = stepJsonSchema();

/** What starts an automation: made from the language's own description of each kind (@kraftverk/automation, kinds/). */
const TRIGGER: Schema = triggerJsonSchema();

function automationSchema(vocabulary: Vocabulary): Schema {
  // The devices the server has, and their parts, offered where a role is filled.
  const parts = vocabulary.devices.flatMap((device) => [device.key, ...device.parts.filter((part) => part !== 'main').map((part) => `${device.key}.${part}`)]);
  const partRef: Schema = parts.length ? { anyOf: [{ enum: parts }, { type: 'string' }] } : { type: 'string' };
  return {
    type: 'object',
    title: 'An automation',
    required: ['name'],
    additionalProperties: false,
    properties: {
      name: { type: 'string', minLength: 1 },
      mode: { enum: ['off', 'watch', 'act'], enumDescriptions: ['Off: it does nothing on its own', 'Watch only: it says what it would have done', 'Act: it acts on its own'], default: 'watch' },
      clock: { type: 'string', description: 'The time zone its times of day are in: "Europe/Stockholm". The home’s, when it says none.' },
      recheck: { $ref: '#/$defs/duration' },
      'home page': { type: 'integer', minimum: 0, description: 'Its place among the home page’s shortcuts.' },
      'made from': { type: 'string', description: 'The recipe it was copied from.' },
      uses: {
        type: 'object',
        description: 'Each role, and what fills it: "device-key" or "device-key.part" — or { automation: key } for one a step starts. Empty (~) while nothing fills it yet.',
        additionalProperties: {
          anyOf: [
            partRef,
            { type: 'null', description: 'Nothing fills it yet.' },
            {
              type: 'object',
              required: ['part'],
              additionalProperties: false,
              properties: { part: { anyOf: [partRef, { type: 'null' }] }, label: { type: 'string' }, description: { type: 'string' }, needs: { type: 'array', items: { type: 'string' } }, 'one of': { type: 'array', items: { type: 'string' } } },
            },
            {
              type: 'object',
              required: ['automation'],
              additionalProperties: false,
              properties: {
                automation: { anyOf: [...(vocabulary.automations.length ? [{ enum: vocabulary.automations.map((each) => each.key) }] : []), { type: 'string' }, { type: 'null' }] },
                label: { type: 'string' },
                description: { type: 'string' },
              },
            },
          ],
        },
      },
      when: { type: 'array', items: { $ref: '#/$defs/trigger' } },
      'only if': { $ref: '#/$defs/expression' },
      do: STEPS,
      'if a step fails': STEPS,
      params: { type: 'object' },
    },
  };
}

/** The pieces every schema here refers to. */
function definitions(vocabulary: Vocabulary): Record<string, Schema> {
  return { device: deviceSchema(vocabulary.types), automation: automationSchema(vocabulary), step: STEP, trigger: TRIGGER, expression: EXPRESSION, duration: DURATION };
}

/** The whole configuration document's schema. */
export function configJsonSchema(vocabulary: Vocabulary): Schema {
  const keys = { propertyNames: { pattern: KEY.source } };
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'A kraftverk configuration',
    type: 'object',
    required: ['kraftverk'],
    additionalProperties: false,
    properties: {
      kraftverk: { const: CURRENT_VERSION, description: 'The document’s version.' },
      home: {
        type: 'object',
        additionalProperties: false,
        properties: {
          clock: { type: 'string', description: 'The time zone the home’s automations keep time in, when one says none of its own: "Europe/Stockholm".' },
          policy: {
            type: 'object',
            additionalProperties: false,
            properties: Object.fromEntries(Object.entries(vocabulary.policy).map(([name, spec]) => [name, { type: 'number', minimum: spec.min, maximum: spec.max, description: `${spec.label}, in ${spec.unit}.` }])),
          },
        },
      },
      devices: { type: 'object', ...keys, additionalProperties: { $ref: '#/$defs/device' } },
      links: {
        type: 'array',
        items: {
          type: 'object',
          minProperties: 1,
          maxProperties: 1,
          propertyNames: { enum: vocabulary.linkKinds },
          additionalProperties: { type: 'object', required: ['from', 'to'], additionalProperties: false, properties: { from: { type: 'string' }, to: { type: 'string' } } },
        },
      },
      automations: { type: 'object', ...keys, additionalProperties: { $ref: '#/$defs/automation' } },
      secrets: { type: 'object', additionalProperties: { type: 'string' } },
    },
    $defs: definitions(vocabulary),
    // Draft-07 readers that look in "definitions" find the same.
    definitions: definitions(vocabulary),
  };
}

/** One entry's schema — an automation's or a device's own YAML, as its page edits it. */
export function entryJsonSchema(vocabulary: Vocabulary, kind: 'automation' | 'device'): Schema {
  const defs = definitions(vocabulary);
  return { $schema: 'http://json-schema.org/draft-07/schema#', ...defs[kind], $defs: defs, definitions: defs };
}
