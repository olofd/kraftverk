import { ApiError, type KraftverkApi, type Rehearsal } from '@kraftverk/api-contract';
import { automationId, isTimeZone, savedDeviceId, type Value } from '@kraftverk/device-sdk';

import { REHEARSAL_MAX_HOURS } from '../automations/drafts.ts';
import { AGENT_RULES, worldText } from './world.ts';

/**
 * The house for an assistant over MCP (PROPOSITION.md §5.1–5.3): its only
 * verbs are the intents — a command through the gateway as an agent, a
 * query, the receipts, starting and stopping what its owner let act, and a
 * proposal: an automation copied from a recipe, only watching until a person
 * lets it act, rehearsed on history. No free-form service calls, and nothing
 * a person has to confirm.
 *
 * Each tool asks the home it is handed — the hub as an agent acting for
 * whoever is signed in (`hub.as`) — so what needs a person's yes is refused
 * it there, in the gateway's words. Pure: the place that serves it carries
 * the messages (the server's \`/api/mcp\`).
 */

const MCP_PROTOCOL = '2025-06-18';

type Json = Record<string, unknown>;
/** What the endpoint says it is: the place's name and version. */
export type McpServerInfo = { name: string; version: string };

// --- the arguments a tool takes: declared once, as the JSON Schema it advertises, and checked against it ---

type Schema = Json & { type?: string | string[] };

const object = (properties: Record<string, Schema>, required: string[] = []): Schema => ({ type: 'object', properties, required, additionalProperties: false });
const text = (description: string, maxLength = 80): Schema => ({ type: 'string', description, minLength: 1, maxLength });
const number = (description: string, minimum: number, maximum: number, integer = false): Schema => ({ type: integer ? 'integer' : 'number', description, minimum, maximum });
const values = (description: string): Schema => ({ type: 'object', description, additionalProperties: { type: ['string', 'number', 'boolean', 'null'], maxLength: 200 } });
const roleBindings: Schema = {
  type: 'object',
  description: 'Each role of the recipe filled by one part of one of your devices: { "battery": { "device": "d-…", "part": "main" } }.',
  additionalProperties: object({ device: text('A device id from the world'), part: text('A part id of that device') }, ['device', 'part']),
};

/** Whether a value is of a JSON Schema type, as the subset here uses them. */
function isType(value: unknown, type: string): boolean {
  if (type === 'null') return value === null;
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'object') return typeof value === 'object' && value !== null && !Array.isArray(value);
  return typeof value === type;
}

/** What is wrong with a value against its schema — each problem with where it is — or nothing. */
function problemsOf(value: unknown, schema: Schema, at: string): string[] {
  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.length && !types.some((type) => isType(value, type))) return [`${at}: should be ${types.join(' or ')}`];
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) return [`${at}: should not be empty`];
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) return [`${at}: at most ${schema.maxLength} characters`];
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) return [`${at}: at least ${schema.minimum}`];
    if (typeof schema.maximum === 'number' && value > schema.maximum) return [`${at}: at most ${schema.maximum}`];
  }
  if (!isType(value, 'object')) return [];
  const given = value as Json;
  const properties = (schema.properties ?? {}) as Record<string, Schema>;
  const required = (schema.required ?? []) as string[];
  const problems = required.filter((key) => given[key] === undefined).map((key) => `${at === 'input' ? key : `${at}.${key}`}: is needed`);
  for (const [key, each] of Object.entries(given)) {
    const where = at === 'input' ? key : `${at}.${key}`;
    // Its own arguments only: `constructor` or `__proto__` is no argument of any tool.
    if (Object.hasOwn(properties, key)) problems.push(...problemsOf(each, properties[key]!, where));
    else if (schema.additionalProperties === false) problems.push(`${where}: is not one of its arguments`);
    else if (typeof schema.additionalProperties === 'object') problems.push(...problemsOf(each, schema.additionalProperties as Schema, where));
  }
  return problems;
}

/** A tool's arguments, as its schema says they are — or refused, saying each thing wrong. */
function checked<T>(args: Json, schema: Schema): T {
  const problems = problemsOf(args, schema, 'input');
  if (problems.length) throw new ApiError('invalid', problems.join('; '), { problems });
  return args as T;
}

// --- the tools -----------------------------------------------------------------------

type Tool = { name: string; description: string; inputSchema: Schema; run: (args: Json, home: KraftverkApi) => Promise<string> };
type Plan = { name: string; recipe: string; roles: Record<string, { device: string; part: string }>; params: Record<string, string | number | boolean>; timeZone?: string };

const PLAN = {
  name: text('What to call it'),
  recipe: text('A recipe id from the vocabulary', 120),
  roles: roleBindings,
  params: { type: 'object', description: 'The recipe’s settings, within their declared ranges', additionalProperties: { type: ['string', 'number', 'boolean'], maxLength: 200 } } as Schema,
  timeZone: text('The home’s clock: "Europe/Stockholm"', 64),
};

/** The home's clock, as given or this one's; one that is not a time zone is refused. */
const clockOf = (given: string | undefined): string => {
  if (given !== undefined && !isTimeZone(given)) throw new ApiError('invalid', 'timeZone: that is not a time zone');
  return given ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
};

/** Roles as the assistant fills them, with their devices' ids as ids. */
const boundOf = (roles: Plan['roles']) => Object.fromEntries(Object.entries(roles).map(([role, binding]) => [role, { device: savedDeviceId(binding.device), part: binding.part }]));

/** A rehearsal in lines: when, what, and what it could not see. */
function rehearsalText(rehearsal: Pick<Rehearsal, 'from' | 'to' | 'runs' | 'caveats'>): string {
  const lines = [`Rehearsed from ${rehearsal.from} to ${rehearsal.to}: ${rehearsal.runs.length ? `${rehearsal.runs.length} run${rehearsal.runs.length === 1 ? '' : 's'}` : 'it would not have run'}.`];
  for (const run of rehearsal.runs) lines.push(`${run.at} ${run.outcome}: ${run.summary}`);
  for (const caveat of rehearsal.caveats) lines.push(`Note: ${caveat}.`);
  return lines.join('\n');
}

const TOOLS: Tool[] = [
  {
    name: 'world',
    description: 'The house now: every device with its id, its parts, what each part offers (capabilities) and reports (with meaning, unit and whether it is current), and the links between parts. Read it before acting.',
    inputSchema: object({}),
    run: async (_, home) => worldText(await home.world()),
  },
  {
    name: 'vocabulary',
    description: 'The words the world is said in: each capability with its commands (typed arguments, and what makes one consequential), queries and meanings; link kinds; the recipes an automation can be made from, with their roles and settings.',
    inputSchema: object({}),
    run: async (_, home) => JSON.stringify(await home.vocabulary()),
  },
  {
    name: 'command',
    description:
      'Send one command to one part of a device, through the gateway: switch.set { on } and the like. It checks the arguments, the dwell time and that readings are current, and reads back what it did. A command that needs a person’s confirmation is refused: say so, and let them do it in the app.',
    inputSchema: object(
      {
        device: text('The device id, from the world'),
        part: text('The part id: "main", "outlet.ac"'),
        capability: text('The capability the part offers: "switch"'),
        command: text('The capability’s command: "set"', 40),
        args: values('The command’s arguments, as the vocabulary types them: { "on": false }'),
        reason: text('Why, in a few words, for the timeline', 200),
      },
      ['device', 'part', 'capability', 'command', 'args', 'reason']
    ),
    run: async (args, home) => {
      const input = checked<{ device: string; part: string; capability: string; command: string; args: Record<string, Value>; reason: string }>(args, TOOL_SCHEMA.command!);
      const result = await home.devices.command(savedDeviceId(input.device), input.part, input.capability, input.command, { args: input.args, reason: input.reason });
      return `${result.outcome}: ${result.detail}`;
    },
  },
  {
    name: 'query',
    description: 'Ask one part of a device a query its capability declares — weather.forecast hourly { hours } — and get the answer in the type the capability declares.',
    inputSchema: object(
      { device: text('The device id'), part: text('The part id'), capability: text('The capability: "weather.forecast"'), query: text('Its query: "hourly"', 40), args: values('The query’s arguments') },
      ['device', 'part', 'capability', 'query']
    ),
    run: async (args, home) => {
      const input = checked<{ device: string; part: string; capability: string; query: string; args?: Record<string, Value> }>(args, TOOL_SCHEMA.query!);
      return JSON.stringify(await home.devices.query(savedDeviceId(input.device), input.part, input.capability, input.query, input.args ?? {}));
    },
  },
  {
    name: 'receipts',
    description: 'What was done lately, newest first: who did what, to what, and what came of it. One device’s, one automation’s, or all.',
    inputSchema: object({ device: text('A device id, for its receipts only'), automation: text('An automation id, for its runs only'), limit: number('How many, at most 100', 1, 100, true) }),
    run: async (args, home) => {
      const input = checked<{ device?: string; automation?: string; limit?: number }>(args, TOOL_SCHEMA.receipts!);
      const entries = await home.timeline({ limit: input.limit ?? 20, ...(input.device ? { resourceKind: 'device', resource: input.device } : input.automation ? { resourceKind: 'automation', resource: input.automation } : {}) });
      return entries.length ? entries.map((entry) => `${entry.at} ${entry.kind} by ${entry.actor}: ${entry.summary}`).join('\n') : 'Nothing yet.';
    },
  },
  {
    name: 'rehearse',
    description: 'Rehearse a recipe on the last hours of history: when it would have run, and what it would have done, and what history cannot show. Nothing is sent and nothing is kept.',
    inputSchema: object({ recipe: PLAN.recipe, roles: PLAN.roles, params: PLAN.params, timeZone: PLAN.timeZone, hours: number(`How far back, at most ${REHEARSAL_MAX_HOURS}`, 1, REHEARSAL_MAX_HOURS) }, ['recipe', 'roles', 'params']),
    run: async (args, home) => {
      const input = checked<Omit<Plan, 'name'> & { hours?: number }>(args, TOOL_SCHEMA.rehearse!);
      const timeZone = clockOf(input.timeZone);
      // The recipe as an automation of it would be: its settings written into its blocks.
      const rule = await home.automations.fromRecipe(input.recipe, input.params);
      try {
        return rehearsalText(await home.automations.rehearse({ draft: { rule, roles: boundOf(input.roles), groups: {}, starts: {} }, timeZone }, input.hours ?? 24 * 7));
      } catch (error) {
        if (error instanceof ApiError && error.kind === 'invalid') return `It cannot be rehearsed as it is: ${error.message}`;
        throw error;
      }
    },
  },
  {
    name: 'automations',
    description:
      'The automations there are: each one’s id, what it does in a sentence, whether it acts on its own or only watches, whether it has anything that starts it on its own (none: it runs when started, as "start charging the scooter"), and whether it runs now — with the step it is in.',
    inputSchema: object({}),
    run: async (_, home) => {
      const all = await home.automations.list();
      if (!all.length) return 'No automations yet.';
      return all
        .map((automation) => {
          const running = automation.running;
          const current = running ? [...running.steps].reverse().find((step) => step.outcome === 'waiting') : null;
          return [
            `${automation.name} [${automation.id}] — ${automation.mode === 'act' ? 'acts on its own' : automation.mode === 'watch' ? 'only watches on its own' : 'off'}${automation.when.length ? '' : ', runs when started'}`,
            `  ${automation.sentence}`,
            running ? `  Running since ${running.at}${current ? `: ${current.what}` : ''}` : automation.lastRun ? `  Last run ${automation.lastRun.at}: ${automation.lastRun.summary}` : '  Never run',
          ].join('\n');
        })
        .join('\n');
    },
  },
  {
    name: 'start',
    description:
      'Start an automation now — a sequence such as "start charging the scooter" — one its owner has let act: it takes its steps from now, each through the gateway. One that only watches is its owner’s to start. Say what it will do before starting it, and follow it with `automations`.',
    inputSchema: object({ automation: text('The automation id, from `automations`') }, ['automation']),
    run: async (args, home) => {
      const input = checked<{ automation: string }>(args, TOOL_SCHEMA.start!);
      try {
        // An assistant's run switches first as an assistant would: its own dwell, not a person's.
        const started = await home.automations.start(automationId(input.automation));
        return `Started. Its steps: ${started.steps.map((step) => step.text).join('; ')}`;
      } catch (error) {
        if (error instanceof ApiError && error.kind === 'conflict') return `Not started: ${error.message}`;
        throw error;
      }
    },
  },
  {
    name: 'stop',
    description: 'Stop an automation’s run in progress: the step it is in ends, and what it does if stopped — switching back off what it switched on — runs.',
    inputSchema: object({ automation: text('The automation id') }, ['automation']),
    run: async (args, home) => {
      const input = checked<{ automation: string }>(args, TOOL_SCHEMA.stop!);
      try {
        await home.automations.stop(automationId(input.automation));
        return 'Stopping: what it does if stopped is running now.';
      } catch (error) {
        if (error instanceof ApiError && error.kind === 'conflict') return `Not stopped: ${error.message}`;
        throw error;
      }
    },
  },
  {
    name: 'propose',
    description:
      'Propose an automation: a recipe from the vocabulary, copied — its settings, within their ranges, written into its steps — and its roles filled from the world. It is made only watching on its own — it decides and says what it would do, and acts on its own only once a person lets it in the app — and is rehearsed on the last week of history. Its owner can change any of its steps in the app.',
    inputSchema: object(PLAN, ['name', 'recipe', 'roles', 'params']),
    run: async (args, home) => {
      const input = checked<Plan>(args, TOOL_SCHEMA.propose!);
      const timeZone = clockOf(input.timeZone);
      const rule = await home.automations.fromRecipe(input.recipe, input.params);
      let created;
      try {
        // Made by an agent, it is a proposal: only watching, on the timeline as one.
        created = await home.automations.create({ name: input.name.trim(), rule, madeFrom: input.recipe, roles: boundOf(input.roles), groups: {}, starts: {}, timeZone });
      } catch (error) {
        if (error instanceof ApiError && error.kind === 'invalid') return `Not made: ${error.message}`;
        throw error;
      }
      const rehearsal = await home.automations.rehearse({ automation: created.id }, 24 * 7);
      return [
        `Made "${created.name}" [${created.id}], only watching: ${created.sentence}`,
        'It acts on its own only once a person lets it, in the app, where they can also change any of its steps.',
        '',
        rehearsalText(rehearsal),
      ].join('\n');
    },
  },
];

const TOOL_SCHEMA: Record<string, Schema> = Object.fromEntries(TOOLS.map((tool) => [tool.name, tool.inputSchema]));

/**
 * One JSON-RPC message, answered: the handshake, the tool list, a tool call.
 * A notification — no id — wants no answer: null. A tool's refusal is an
 * answer a model reads and acts on, not a protocol failure.
 */
export async function answerMcp(message: Json, home: KraftverkApi, server: McpServerInfo): Promise<Json | null> {
  const id = message.id as string | number | undefined;
  const reply = (result: Json) => ({ jsonrpc: '2.0', id, result });
  const fail = (code: number, said: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message: said } });
  if (id === undefined) return null;
  switch (message.method) {
    case 'initialize':
      return reply({
        protocolVersion: MCP_PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: server,
        instructions: ['You act in a home through kraftverk. Read the world first; act only through the tools.', ...AGENT_RULES].join('\n'),
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case 'tools/call': {
      const params = (message.params ?? {}) as { name?: string; arguments?: Json };
      const tool = TOOLS.find((candidate) => candidate.name === params.name);
      if (!tool) return fail(-32602, `There is no tool "${params.name}"`);
      const args = params.arguments ?? {};
      if (typeof args !== 'object' || Array.isArray(args)) return fail(-32602, 'A tool’s arguments are an object');
      try {
        return reply({ content: [{ type: 'text', text: await tool.run(args, home) }] });
      } catch (error) {
        /*
          The home's refusal is said as it is: the model reads it and acts on
          it. Anything else is a fault inside kraftverk — its words, a path or
          a query, are the server log's, not an assistant's to read.
        */
        if (error instanceof ApiError) return reply({ content: [{ type: 'text', text: error.message }], isError: true });
        console.error(`[assistant] The tool ${tool.name} failed:`, error);
        return reply({ content: [{ type: 'text', text: `The tool ${tool.name} failed inside kraftverk; the server's log says why.` }], isError: true });
      }
    }
    default:
      return fail(-32601, `No method "${String(message.method)}"`);
  }
}
