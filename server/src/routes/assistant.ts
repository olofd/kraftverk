import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';

import { isTimeZone, savedDeviceId, type CapabilitySpec, type Value } from '@kraftverk/device-sdk';
import { deviceReader } from '@kraftverk/holder';

import { actorOf } from '../auth/routes.ts';
import { plans, REHEARSAL_MAX_HOURS } from '../automations/plans.ts';
import { AGENT_RULES, vocabularyOf, worldOf, worldText } from '../assistant/world.ts';
import { recentAudit } from '../history/db.ts';
import { policyValues } from '../history/policy.ts';
import { auditAbout, type AppDeps } from './shared.ts';

/**
 * The house for an assistant (PROPOSITION.md §5.1–5.3): the world as a model
 * reads it, the words it is said in, and an MCP endpoint whose only verbs are
 * the intents — a command through the gateway as an agent, a query, the
 * receipts, and a proposal: an automation made from a recipe, observing until
 * a person arms it, rehearsed on history. No free-form service calls, and
 * nothing a person has to confirm.
 *
 * Behind the same sign-in as every route: an MCP client sends the session
 * cookie and the client header, as the app does.
 */

const MCP_PROTOCOL = '2025-06-18';

type Json = Record<string, unknown>;
type Tool = { name: string; description: string; inputSchema: Json; run: (args: Json, c: Context) => Promise<string> };

const object = (properties: Json, required: string[] = []): Json => ({ type: 'object', properties, required, additionalProperties: false });
const text = (description: string): Json => ({ type: 'string', description });
const roleBindings: Json = {
  type: 'object',
  description: 'Each role of the recipe filled by one part of one of your devices: { "battery": { "device": "d-…", "part": "main" } }.',
  additionalProperties: object({ device: text('A device id from the world'), part: text('A part id of that device') }, ['device', 'part']),
};

export function assistantRoutes(deps: AppDeps): Hono {
  const { config, registry, library, gateway, sessions, catalog, automations, engine } = deps;
  const api = new Hono();
  const { view, validated, rehearsed } = plans({ catalog, sessions, library, engine });

  const world = async () => worldOf(await registry.all(), { readOnly: config.readOnly });
  const vocabulary = async () =>
    vocabularyOf(
      library,
      policyValues(),
      (await registry.all()).map((device) => (device.description.capabilities ?? {}) as Record<string, CapabilitySpec>)
    );

  /** The house now: every device, its parts, what each offers and reports and how fresh, and the links. `?format=text` for a context window. */
  api.get('/world', async (c) => {
    const now = await world();
    return c.req.query('format') === 'text' ? c.text(worldText(now)) : c.json(now);
  });

  /** The words the world is said in: capabilities, meanings, link kinds, recipes, and the values the home has set. */
  api.get('/vocabulary', async (c) => c.json(await vocabulary()));

  const tools: Tool[] = [
    {
      name: 'world',
      description: 'The house now: every device with its id, its parts, what each part offers (capabilities) and reports (with meaning, unit and whether it is current), and the links between parts. Read it before acting.',
      inputSchema: object({}),
      run: async () => worldText(await world()),
    },
    {
      name: 'vocabulary',
      description: 'The words the world is said in: each capability with its commands (typed arguments, and what makes one consequential), queries and meanings; link kinds; the recipes an automation can be made from, with their roles and settings.',
      inputSchema: object({}),
      run: async () => JSON.stringify(await vocabulary()),
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
          command: text('The capability’s command: "set"'),
          args: { type: 'object', description: 'The command’s arguments, as the vocabulary types them: { "on": false }' },
          reason: text('Why, in a few words, for the timeline'),
        },
        ['device', 'part', 'capability', 'command', 'args', 'reason']
      ),
      run: async (args, c) => {
        const input = z
          .object({ device: z.string().min(1).max(80), part: z.string().min(1).max(80), capability: z.string().min(1).max(80), command: z.string().min(1).max(40), args: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])), reason: z.string().min(1).max(200) })
          .parse(args);
        const result = await gateway.execute({
          deviceId: savedDeviceId(input.device),
          part: input.part,
          capability: input.capability,
          command: input.command,
          args: input.args as Record<string, Value>,
          reason: input.reason,
          actor: 'agent',
          by: `assistant for ${actorOf(c)}`,
        });
        return `${result.outcome}: ${result.detail}`;
      },
    },
    {
      name: 'query',
      description: 'Ask one part of a device a query its capability declares — weather.forecast hourly { hours } — and get the answer in the type the capability declares.',
      inputSchema: object(
        { device: text('The device id'), part: text('The part id'), capability: text('The capability: "weather.forecast"'), query: text('Its query: "hourly"'), args: { type: 'object', description: 'The query’s arguments' } },
        ['device', 'part', 'capability', 'query']
      ),
      run: async (args) => {
        const input = z.object({ device: z.string().min(1).max(80), part: z.string().min(1).max(80), capability: z.string().min(1).max(80), query: z.string().min(1).max(40), args: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}) }).parse(args);
        const record = catalog.active(savedDeviceId(input.device));
        const session = record ? sessions.get(record.id) : null;
        if (!record || !session) throw new Error(record ? `${record.name} is not answering: ${sessions.health(record).detail}` : 'No such device');
        const answer = await deviceReader(session, () => sessions.description(record)).query({ part: input.part, capability: input.capability, query: input.query, args: input.args as Record<string, Value> });
        return JSON.stringify(answer);
      },
    },
    {
      name: 'receipts',
      description: 'What was done lately, newest first: who did what, to what, and what came of it. One device’s, one automation’s, or all.',
      inputSchema: object({ device: text('A device id, for its receipts only'), automation: text('An automation id, for its runs only'), limit: { type: 'number', description: 'How many, at most 100' } }),
      run: async (args) => {
        const input = z.object({ device: z.string().max(80).optional(), automation: z.string().max(80).optional(), limit: z.number().int().min(1).max(100).default(20) }).parse(args);
        const entries = recentAudit({ limit: input.limit, ...(input.device ? { resourceKind: 'device', resource: input.device } : input.automation ? { resourceKind: 'automation', resource: input.automation } : {}) });
        return entries.length ? entries.map((entry) => `${entry.at} ${entry.kind} by ${entry.actor}: ${entry.summary}`).join('\n') : 'Nothing yet.';
      },
    },
    {
      name: 'rehearse',
      description: 'Rehearse a recipe on the last hours of history: when it would have run, and what it would have done, and what history cannot show. Nothing is sent and nothing is kept.',
      inputSchema: object({ recipe: text('A recipe id from the vocabulary'), roles: roleBindings, params: { type: 'object', description: 'The recipe’s settings, within their declared ranges' }, timeZone: text('The home’s clock: "Europe/Stockholm"'), hours: { type: 'number', description: `How far back, at most ${REHEARSAL_MAX_HOURS}` } }, ['recipe', 'roles', 'params']),
      run: async (args) => {
        const input = planInput.extend({ hours: z.number().min(1).max(REHEARSAL_MAX_HOURS).default(24 * 7) }).omit({ name: true }).parse(args);
        const checked = validated(input.recipe, input);
        return rehearsalText(await rehearsed(input.recipe, { roles: checked.roles, params: checked.params, timeZone: input.timeZone }, input.hours));
      },
    },
    {
      name: 'propose',
      description:
        'Propose an automation: a recipe from the vocabulary, its roles filled from the world and its settings within their ranges. It is made observing — it decides and says what it would do, and acts only once a person arms it in the app — and is rehearsed on the last week of history.',
      inputSchema: object({ name: text('What to call it'), recipe: text('A recipe id from the vocabulary'), roles: roleBindings, params: { type: 'object', description: 'The recipe’s settings' }, timeZone: text('The home’s clock: "Europe/Stockholm"') }, ['name', 'recipe', 'roles', 'params']),
      run: async (args, c) => {
        const input = planInput.parse(args);
        const checked = validated(input.recipe, input);
        const created = automations.create({ name: input.name, recipe: input.recipe, roles: checked.roles, params: checked.params, timeZone: input.timeZone });
        auditAbout(c, 'automation.proposed', 'automation', created.id, `An assistant proposed "${created.name}", observing: ${view(created).sentence}`, { recipe: created.recipe, roles: created.roles, params: created.params });
        const rehearsal = await rehearsed(created.recipe, created, 24 * 7);
        return [`Made "${created.name}" [${created.id}], observing: ${view(created).sentence}`, 'It acts only once a person arms it in the app.', '', rehearsalText(rehearsal)].join('\n');
      },
    },
  ];

  const planInput = z.object({
    name: z.string().trim().min(1).max(80),
    recipe: z.string().min(1).max(120),
    roles: z.record(z.string().min(1).max(40), z.object({ device: z.string().min(1).max(80), part: z.string().min(1).max(80) }).strict()),
    params: z.record(z.string().min(1).max(40), z.union([z.string().max(200), z.number(), z.boolean()])),
    timeZone: z
      .string()
      .min(1)
      .max(64)
      .refine(isTimeZone, 'That is not a time zone')
      .default(Intl.DateTimeFormat().resolvedOptions().timeZone),
  });

  /** One JSON-RPC message, answered: the handshake, the tool list, a tool call. */
  const answer = async (message: Json, c: Context): Promise<Json | null> => {
    const id = message.id as string | number | undefined;
    const reply = (result: Json) => ({ jsonrpc: '2.0', id, result });
    const fail = (code: number, text: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message: text } });
    // A notification has no id and wants no answer.
    if (id === undefined) return null;
    switch (message.method) {
      case 'initialize':
        return reply({
          protocolVersion: MCP_PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: { name: 'kraftverk', version: '0.1.0' },
          instructions: ['You act in a home through kraftverk. Read the world first; act only through the tools.', ...AGENT_RULES].join('\n'),
        });
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
      case 'tools/call': {
        const params = (message.params ?? {}) as { name?: string; arguments?: Json };
        const tool = tools.find((candidate) => candidate.name === params.name);
        if (!tool) return fail(-32602, `There is no tool "${params.name}"`);
        try {
          return reply({ content: [{ type: 'text', text: await tool.run(params.arguments ?? {}, c) }] });
        } catch (error) {
          // A refusal is an answer a model reads and acts on, not a protocol failure.
          const said = error instanceof z.ZodError ? error.issues.map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`).join('; ') : error instanceof HTTPException ? error.message : (error as Error).message;
          return reply({ content: [{ type: 'text', text: said }], isError: true });
        }
      }
      default:
        return fail(-32601, `No method "${String(message.method)}"`);
    }
  };

  /**
   * MCP over HTTP: JSON-RPC in, JSON out — one message or a batch. Nothing
   * streams, so there is no event stream to open (GET answers 405).
   */
  api.post('/mcp', async (c) => {
    const payload = (await c.req.json().catch(() => null)) as Json | Json[] | null;
    if (!payload || typeof payload !== 'object') return c.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'That is not JSON' } }, 400);
    const messages = Array.isArray(payload) ? payload : [payload];
    const answers = (await Promise.all(messages.map((message) => answer(message, c)))).filter((reply): reply is Json => reply !== null);
    if (!answers.length) return c.body(null, 202);
    return c.json(Array.isArray(payload) ? answers : answers[0]!);
  });
  api.get('/mcp', (c) => c.json({ error: 'This MCP endpoint answers POSTs; it has no event stream.' }, 405));

  return api;
}

/** A rehearsal in lines: when, what, and what it could not see. */
function rehearsalText(rehearsal: { from: string; to: string; runs: { at: string; outcome: string; summary: string }[]; caveats: string[] }): string {
  const lines = [`Rehearsed from ${rehearsal.from} to ${rehearsal.to}: ${rehearsal.runs.length ? `${rehearsal.runs.length} run${rehearsal.runs.length === 1 ? '' : 's'}` : 'it would not have run'}.`];
  for (const run of rehearsal.runs) lines.push(`${run.at} ${run.outcome}: ${run.summary}`);
  for (const caveat of rehearsal.caveats) lines.push(`Note: ${caveat}.`);
  return lines.join('\n');
}
