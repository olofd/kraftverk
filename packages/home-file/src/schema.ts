import { stepJsonSchema, triggerJsonSchema, WHILE_RUNNING } from '@kraftverk/automation';
import type { ConfigField, ConfigSchema } from '@kraftverk/device-sdk';

import { KEY, unitsOfQuantity, UNIT_LIST } from '@kraftverk/device-sdk';
import { OPENING_KINDS, SPACE_KINDS, SPACE_PURPOSES } from './document.ts';
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

/** A point in a frame: metres along its x and y axes. */
const POINT: Schema = { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2, description: 'Metres in its frame: [x, y].' };

/** Where a device is, by keys. */
const PLACE: Schema = {
  type: 'object',
  required: ['home'],
  additionalProperties: false,
  properties: {
    home: { type: 'string' },
    space: { type: 'string' },
    opening: { type: 'string' },
    at: { ...POINT, description: 'Where in the space: metres in its frame, [x, y].' },
    height: { type: 'number', description: 'Metres above the floor.' },
    facing: { type: 'number', minimum: 0, exclusiveMaximum: 360, description: 'Which way it looks: degrees in the space’s frame.' },
  },
};

/** Labels, by key. */
const LABELS: Schema = { type: 'array', items: { type: 'string' }, uniqueItems: true, description: 'Its labels, by key: [heating, upstairs].' };

/** A space of a home, and the spaces inside it. */
const SPACE: Schema = {
  type: 'object',
  title: 'A space',
  required: ['kind'],
  additionalProperties: false,
  properties: {
    kind: { enum: [...SPACE_KINDS] },
    name: { type: 'string', minLength: 1, maxLength: 60, description: 'Its key, when it says none.' },
    purpose: { enum: [...SPACE_PURPOSES], description: 'What it is for: a kitchen, a bedroom.' },
    level: { type: 'integer', description: 'A floor’s: 0 the ground floor, -1 the cellar.' },
    elevation: { type: 'number', description: 'A floor’s: metres above the ground.' },
    height: { type: 'number', exclusiveMinimum: 0, description: 'Metres from floor to ceiling.' },
    frame: {
      type: 'object',
      required: ['x', 'y', 'turn'],
      additionalProperties: false,
      properties: { x: { type: 'number' }, y: { type: 'number' }, turn: { type: 'number', minimum: 0, exclusiveMaximum: 360 } },
      description: 'Its own frame: where its origin is in its parent’s, in metres, and its turn in degrees.',
    },
    outline: { type: 'array', items: POINT, minItems: 3, description: 'Its corners in its own frame, in order: [[0, 0], [4, 0], [4, 3], [0, 3]].' },
    plan: {
      type: 'object',
      required: ['picture', 'scale', 'x', 'y'],
      additionalProperties: false,
      properties: {
        picture: { type: 'string', pattern: '^[0-9a-f]{64}$', description: 'The drawing: its picture’s id.' },
        scale: { type: 'number', exclusiveMinimum: 0, description: 'The metres a pixel is.' },
        x: { type: 'number', description: 'Where its top-left corner falls: metres in the floor’s frame.' },
        y: { type: 'number' },
        turn: { type: 'number', minimum: 0, exclusiveMaximum: 360, description: 'Degrees it is turned about that corner.' },
      },
      description: 'A floor’s drawing, placed in its frame: what rooms are traced over.',
    },
    labels: { ...LABELS, description: 'Its labels, by key: on what stands in it too.' },
    spaces: { type: 'object', propertyNames: { pattern: KEY.source }, additionalProperties: { $ref: '#/$defs/space' }, description: 'The spaces inside it, by key.' },
  },
};

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
      paused: { type: 'boolean', description: 'Paused by its owner: kept, and not reached, until resumed.' },
      track: { type: 'string', pattern: '^[0-9]+ ?days?$', description: 'How long where it has been is kept: "30 days", from 1 day to 366. Where it was is never in the file.' },
      place: { ...PLACE, description: 'Where it stands: a home by its key, a space of it — the home itself when none — perhaps an opening it is at.' },
      based: { ...PLACE, description: 'Where one that moves is based — a car, a scooter: a home by its key, perhaps a space of it.' },
      people: {
        type: 'object',
        description: 'Who it is with, by the people’s keys in this file: who carries it — where it is, they are — drives it, owns it, uses it.',
        additionalProperties: false,
        properties: {
          carries: { type: 'string', description: 'Who carries it: its position is theirs.' },
          drives: { type: 'string', description: 'Its usual driver.' },
          owns: { type: 'array', items: { type: 'string' }, description: 'Whose it is.' },
          uses: { type: 'array', items: { type: 'string' }, description: 'Who uses it.' },
        },
      },
      labels: LABELS,
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
            through: { type: 'string', description: 'The key of the device it is reached through — an account, a gateway — when its way goes through one; its address is then its key there.' },
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
/** A number with its unit, as the rule's own data keeps it — the unit one kraftverk knows (units.ts). */
const LITERAL: Schema = {
  type: 'object',
  required: ['value'],
  additionalProperties: false,
  properties: { value: {}, unit: { enum: [...UNIT_LIST], description: 'The unit it is written in' } },
};

const TIME_UNITS = unitsOfQuantity('duration');

const DURATION: Schema = {
  anyOf: [
    {
      type: 'string',
      pattern: `^\\s*-?\\d+(\\.\\d+)?\\s*(${TIME_UNITS.join('|')})\\s*$`,
      description: `A length of time with its unit, one of ${TIME_UNITS.join(', ')}: "5 s", "2 min", "1 h".`,
      examples: ['5 s', '2 min', '1 h'],
    },
    { type: 'string', pattern: '^\\s*\\D', description: 'An expression for a length of time: a setting, or a sum of lengths of time.' },
    LITERAL,
    { type: 'object' },
  ],
};

/** A condition or value: an expression's text — or a plain value, or the rule's own data. */
const EXPRESSION: Schema = {
  anyOf: [
    {
      type: 'string',
      description:
        'An expression: a reading `role.meaning` ("charger.power"), `role reachable`, `run.trigger` (the id of the trigger that started the run), numbers with units ("50 W" — ' +
        UNIT_LIST.join(', ') +
        '), times ("07:00"), "text", compared with < <= > >= == !=, joined with and, or, not; `x in [a, b]`; `time between 23:00 and 05:00`; + - * / and -x; `c ? a : b`; `a ?? b`; min, max, clamp, round, floor, ceil, abs; `setting.name`; `package.fn(role, name = value)`.',
    },
    { type: 'number' },
    { type: 'boolean' },
    { type: 'null' },
    LITERAL,
    { type: 'object' },
  ],
};

const STEPS: Schema = { type: 'array', items: { $ref: '#/$defs/step' } };

/** A step: made from the language's own description of each kind (@kraftverk/automation, kinds/) — its fields under its verb, or its own words' forms. */
const STEP: Schema = stepJsonSchema();

/** What starts an automation: made from the language's own description of each kind (@kraftverk/automation, kinds/). */
const TRIGGER: Schema = triggerJsonSchema();

/** One of an automation's settings, or of what it remembers: its value alone, or with its title, range and how it is set. */
const FORM_FIELD: Schema = {
  anyOf: [
    { type: ['number', 'boolean', 'string'], description: 'Its value: a number with its unit ("20 %", "2 min"), on or off, or a text.' },
    {
      type: 'object',
      required: ['value'],
      additionalProperties: false,
      properties: {
        title: { type: 'string', description: 'What the app calls it.' },
        description: { type: 'string' },
        value: { type: ['number', 'boolean', 'string'], description: 'Its value: a number with its unit, on or off, a text, or one of its options.' },
        min: { type: ['number', 'string'], description: 'The least it may be, in its unit.' },
        max: { type: ['number', 'string'], description: 'The most it may be, in its unit.' },
        step: { type: ['number', 'string'], description: 'What it moves by, in its unit.' },
        integer: { type: 'boolean', description: 'Whole numbers only.' },
        slider: { type: 'boolean', description: 'Set with a slider.' },
        options: { type: 'object', additionalProperties: { type: 'string' }, description: 'Each option by its value, with its words.' },
      },
    },
  ],
};

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
      home: { type: 'string', description: 'The key of the home it is for: its clock, and its "home". The family’s, when it says none.' },
      clock: { type: 'string', description: 'A clock of its own: the time zone its times of day are in, "Europe/Stockholm". Its home’s, when it says none.' },
      recheck: { $ref: '#/$defs/duration' },
      'made from': { type: 'string', description: 'The recipe it was copied from.' },
      labels: LABELS,
      settings: {
        type: 'object',
        description: 'Its settings, each by its name, read in its rule as setting.name: a value alone ("low: 20 %"), or with its title, range and how it is set.',
        additionalProperties: FORM_FIELD,
      },
      memory: {
        type: 'object',
        description: 'What it remembers, each by its name, read as memory.name and set by a remember step: the value it starts from ("timesCharged: 0"), or with its title and range. Kept across runs and restarts.',
        additionalProperties: FORM_FIELD,
      },
      inputs: {
        type: 'object',
        description: 'What another automation’s start step may give it under "with", each by its name, read as given.name: what it takes when not given ("level: 80 %"), or with its title and range.',
        additionalProperties: FORM_FIELD,
      },
      result: { ...FORM_FIELD, description: 'What it answers: an answer step gives it, and a start step that waits remembers it ("remember as").' },
      uses: {
        type: 'object',
        description: 'Each role, and what fills it: "device-key" or "device-key.part"; a list of them for a group a "for each" goes through; or { automation: key } for one a step starts. Empty (~) while nothing fills it yet.',
        additionalProperties: {
          anyOf: [
            partRef,
            { type: 'null', description: 'Nothing fills it yet.' },
            { type: 'array', items: partRef, uniqueItems: true, description: 'A group: the parts a "for each" goes through, in order.' },
            {
              type: 'object',
              required: ['parts'],
              additionalProperties: false,
              properties: { parts: { type: 'array', items: partRef, uniqueItems: true }, label: { type: 'string' }, needs: { type: 'array', items: { type: 'string' } }, 'one of': { type: 'array', items: { type: 'string' } } },
            },
            {
              type: 'object',
              required: ['part'],
              additionalProperties: false,
              properties: { part: { anyOf: [partRef, { type: 'null' }] }, label: { type: 'string' }, needs: { type: 'array', items: { type: 'string' } }, 'one of': { type: 'array', items: { type: 'string' } } },
            },
            {
              type: 'object',
              required: ['automation'],
              additionalProperties: false,
              properties: {
                automation: { anyOf: [...(vocabulary.automations.length ? [{ enum: vocabulary.automations.map((each) => each.key) }] : []), { type: 'string' }, { type: 'null' }] },
                label: { type: 'string' },
              },
            },
          ],
        },
      },
      when: { type: 'array', items: { $ref: '#/$defs/trigger' } },
      'while running': {
        enum: Object.keys(WHILE_RUNNING),
        enumDescriptions: Object.values(WHILE_RUNNING).map((way) => `${way.label}: ${way.says}`),
        default: 'skip',
        description: 'What one of its triggers starting it while it runs does.',
      },
      'only if': { $ref: '#/$defs/expression' },
      do: STEPS,
      'if a step fails': STEPS,
    },
  };
}

/** The pieces every schema here refers to. */
function definitions(vocabulary: Vocabulary): Record<string, Schema> {
  return { device: deviceSchema(vocabulary.types), automation: automationSchema(vocabulary), space: SPACE, step: STEP, trigger: TRIGGER, expression: EXPRESSION, duration: DURATION };
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
      family: {
        type: 'object',
        description: 'The family itself: the people who share its devices, nodes and homes.',
        additionalProperties: false,
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 60 },
          kind: { enum: ['family', 'household', 'friends', 'other'], description: 'Only the words on screen: "your family", "your household", "your friends", "your group".' },
          locale: { type: 'string', description: 'The language what is said to all of it is said in: "en-GB", "sv-SE".' },
        },
      },
      people: {
        type: 'object',
        ...keys,
        description: 'Its people, each by a key for this file: their id, and who they are as they prove it.',
        additionalProperties: {
          type: 'object',
          required: ['id', 'name', 'chain'],
          additionalProperties: false,
          properties: {
            id: { type: 'string', pattern: '^p-[0-9A-HJKMNP-TV-Z]{26}$' },
            name: { type: 'string', minLength: 1, maxLength: 100, description: 'Their name, for whoever reads the file: their chain says it.' },
            role: { enum: ['admin', 'member', 'child'], default: 'member' },
            nickname: { type: 'string', minLength: 1, maxLength: 30, description: 'What this family calls them.' },
            color: { type: 'string', pattern: '^#[0-9a-f]{6}$' },
            chain: { type: 'string', description: 'Who they are, as they prove it: their signed statements, as the file was written. Not to be edited.' },
            shortcuts: { type: 'array', items: { type: 'string' }, description: 'Their own shortcuts on their home page: automations by key, in order.' },
            sharing: {
              type: 'object',
              description: 'What they share with the family of where they are, and how long their stays are kept.',
              additionalProperties: false,
              required: ['level'],
              properties: {
                level: { enum: ['precise', 'places', 'home-away', 'off'], enumDescriptions: ['Where they are on the map', 'Which home, zone or room — never coordinates', 'Only whether they are home', 'Nothing'] },
                keep: { type: 'string', pattern: '^[0-9]+ ?days?$', description: 'How long their stays are kept: "90 days", 1 to 366.' },
              },
            },
          },
        },
      },
      labels: {
        type: 'object',
        ...keys,
        description: 'Its labels, by key: any grouping it wants — "upstairs", "heating" — on devices, spaces and automations.',
        additionalProperties: {
          type: 'object',
          additionalProperties: false,
          properties: { name: { type: 'string', minLength: 1, maxLength: 30 }, color: { type: 'string', pattern: '^#[0-9a-f]{6}$' }, icon: { type: 'string' } },
        },
      },
      zones: {
        type: 'object',
        ...keys,
        description: 'Its zones, by key: places it knows that are no home — school, work — where presence says someone is.',
        additionalProperties: {
          type: 'object',
          required: ['name', 'location'],
          additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 60 },
            icon: { type: 'string' },
            location: {
              type: 'object',
              description: 'Where it is, in degrees, and its geofence in metres.',
              required: ['latitude', 'longitude'],
              additionalProperties: false,
              properties: { latitude: { type: 'number', minimum: -90, maximum: 90 }, longitude: { type: 'number', minimum: -180, maximum: 180 }, radius: { type: 'number', exclusiveMinimum: 0, maximum: 50000 } },
            },
          },
        },
      },
      homes: {
        type: 'object',
        ...keys,
        description: 'Its homes, by key, in their order.',
        additionalProperties: {
          type: 'object',
          title: 'A home',
          required: ['name', 'time zone'],
          additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 60 },
            type: { enum: ['house', 'apartment', 'cabin', 'boat', 'caravan', 'office', 'other'], default: 'house' },
            picture: { type: 'string', pattern: '^[0-9a-f]{64}$', description: 'A photo of it: its picture’s id, the SHA-256 of its bytes.' },
            location: {
              type: 'object',
              description: 'Where it is, in degrees: what sunrise and sunset are told by. And its geofence, in metres.',
              required: ['latitude', 'longitude'],
              additionalProperties: false,
              properties: { latitude: { type: 'number', minimum: -90, maximum: 90 }, longitude: { type: 'number', minimum: -180, maximum: 180 }, radius: { type: 'number', exclusiveMinimum: 0, maximum: 50000 } },
            },
            'time zone': { type: 'string', description: 'What its clocks keep, and its automations unless one says its own: "Europe/Stockholm".' },
            address: {
              type: 'object',
              additionalProperties: false,
              properties: { street: { type: 'string' }, 'postal code': { type: 'string' }, locality: { type: 'string' }, region: { type: 'string' } },
            },
            country: { type: 'string', pattern: '^[A-Z]{2}$', description: 'Its two letters: SE, GB.' },
            policy: {
              type: 'object',
              additionalProperties: false,
              properties: Object.fromEntries(Object.entries(vocabulary.policy).map(([name, spec]) => [name, { type: 'number', minimum: spec.min, maximum: spec.max, description: `${spec.label}, in ${spec.unit}.` }])),
            },
            spaces: { type: 'object', ...keys, additionalProperties: { $ref: '#/$defs/space' }, description: 'Its buildings, floors, rooms and the outdoors, by key — unique within the home — each with the spaces inside it.' },
            openings: {
              type: 'object',
              ...keys,
              description: 'Where its spaces meet, or meet the outside: doors, stairs, windows, by key.',
              additionalProperties: {
                type: 'object',
                required: ['kind', 'from', 'to'],
                additionalProperties: false,
                properties: { kind: { enum: [...OPENING_KINDS] }, from: { type: 'string' }, to: { type: 'string', description: 'A space’s key, or "outside".' }, name: { type: 'string' }, shape: { type: 'array', items: POINT, minItems: 2, description: 'Where in the wall it is: a line in its from space’s frame.' } },
              },
            },
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
