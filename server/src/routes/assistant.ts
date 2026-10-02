import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';

import { ApiError, type KraftverkApi, type RoleBinding } from '@kraftverk/api-contract';
import { automationId, isTimeZone, savedDeviceId, type Value } from '@kraftverk/device-sdk';
import { AGENT_RULES, REHEARSAL_MAX_HOURS, worldText } from '@kraftverk/hub';

import { actorOf } from '../auth/routes.ts';
import { homeFor, type AppDeps } from './shared.ts';

/**
 * The house for an assistant (PROPOSITION.md §5.1–5.3): the world as a model
 * reads it, the words it is said in, and an MCP endpoint whose only verbs are
 * the intents — a command through the gateway as an agent, a query, the
 * receipts, starting and stopping what its owner let act, and a proposal: an
 * automation copied from a recipe, observing until a person lets it act,
 * rehearsed on history. No free-form service calls, and
 * nothing a person has to confirm.
 *
 * Behind the same sign-in as every route: an MCP client sends the session
 * cookie and the client header, as the app does. Each tool asks the home
 * (`KraftverkApi`) as an agent acting for whoever is signed in: what needs a
 * person's yes is refused it there, in the gateway's words.
 */

const MCP_PROTOCOL = '2025-06-18';

type Json = Record<string, unknown>;
type Tool = { name: string; description: string; inputSchema: Json; run: (args: Json, home: KraftverkApi) => Promise<string> };

const object = (properties: Json, required: string[] = []): Json => ({ type: 'object', properties, required, additionalProperties: false });
const text = (description: string): Json => ({ type: 'string', description });
const roleBindings: Json = {
  type: 'object',
  description: 'Each role of the recipe filled by one part of one of your devices: { "battery": { "device": "d-…", "part": "main" } }.',
  additionalProperties: object({ device: text('A device id from the world'), part: text('A part id of that device') }, ['device', 'part']),
};

/** Roles as the assistant fills them, with their devices' ids as ids. */
const boundOf = (roles: Record<string, { device: string; part: string }>): Record<string, RoleBinding> =>
  Object.fromEntries(Object.entries(roles).map(([role, binding]) => [role, { device: savedDeviceId(binding.device), part: binding.part }]));

export function assistantRoutes(deps: AppDeps): Hono {
  const api = new Hono();

  /** The house now: every device, its parts, what each offers and reports and how fresh, and the links. `?format=text` for a context window. */
  api.get('/world', async (c) => {
    const now = await homeFor(deps, c).world();
    return c.req.query('format') === 'text' ? c.text(worldText(now)) : c.json(now);
  });

  /** The words the world is said in: capabilities, meanings, link kinds, recipes, and the values the home has set. */
  api.get('/vocabulary', async (c) => c.json(await homeFor(deps, c).vocabulary()));

  const tools: Tool[] = [
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
          command: text('The capability’s command: "set"'),
          args: { type: 'object', description: 'The command’s arguments, as the vocabulary types them: { "on": false }' },
          reason: text('Why, in a few words, for the timeline'),
        },
        ['device', 'part', 'capability', 'command', 'args', 'reason']
      ),
      run: async (args, home) => {
        const input = z
          .object({ device: z.string().min(1).max(80), part: z.string().min(1).max(80), capability: z.string().min(1).max(80), command: z.string().min(1).max(40), args: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])), reason: z.string().min(1).max(200) })
          .parse(args);
        const result = await home.devices.command(savedDeviceId(input.device), input.part, input.capability, input.command, { args: input.args as Record<string, Value>, reason: input.reason });
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
      run: async (args, home) => {
        const input = z.object({ device: z.string().min(1).max(80), part: z.string().min(1).max(80), capability: z.string().min(1).max(80), query: z.string().min(1).max(40), args: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}) }).parse(args);
        return JSON.stringify(await home.devices.query(savedDeviceId(input.device), input.part, input.capability, input.query, input.args as Record<string, Value>));
      },
    },
    {
      name: 'receipts',
      description: 'What was done lately, newest first: who did what, to what, and what came of it. One device’s, one automation’s, or all.',
      inputSchema: object({ device: text('A device id, for its receipts only'), automation: text('An automation id, for its runs only'), limit: { type: 'number', description: 'How many, at most 100' } }),
      run: async (args, home) => {
        const input = z.object({ device: z.string().max(80).optional(), automation: z.string().max(80).optional(), limit: z.number().int().min(1).max(100).default(20) }).parse(args);
        const entries = await home.timeline({ limit: input.limit, ...(input.device ? { resourceKind: 'device', resource: input.device } : input.automation ? { resourceKind: 'automation', resource: input.automation } : {}) });
        return entries.length ? entries.map((entry) => `${entry.at} ${entry.kind} by ${entry.actor}: ${entry.summary}`).join('\n') : 'Nothing yet.';
      },
    },
    {
      name: 'rehearse',
      description: 'Rehearse a recipe on the last hours of history: when it would have run, and what it would have done, and what history cannot show. Nothing is sent and nothing is kept.',
      inputSchema: object({ recipe: text('A recipe id from the vocabulary'), roles: roleBindings, params: { type: 'object', description: 'The recipe’s settings, within their declared ranges' }, timeZone: text('The home’s clock: "Europe/Stockholm"'), hours: { type: 'number', description: `How far back, at most ${REHEARSAL_MAX_HOURS}` } }, ['recipe', 'roles', 'params']),
      run: async (args, home) => {
        const input = planInput.extend({ hours: z.number().min(1).max(REHEARSAL_MAX_HOURS).default(24 * 7) }).omit({ name: true }).parse(args);
        // The recipe as an automation of it would be: its settings written into its blocks.
        const rule = await home.automations.fromRecipe(input.recipe, input.params);
        try {
          return rehearsalText(await home.automations.rehearse({ draft: { rule, roles: boundOf(input.roles), starts: {} }, timeZone: input.timeZone }, input.hours));
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
              `${automation.name} [${automation.id}] — ${automation.mode === 'armed' ? 'acts on its own' : automation.mode === 'observe' ? 'only watches on its own' : 'off'}${automation.when.length ? '' : ', runs when started'}`,
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
        const input = z.object({ automation: z.string().min(1).max(80) }).parse(args);
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
        const input = z.object({ automation: z.string().min(1).max(80) }).parse(args);
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
      inputSchema: object({ name: text('What to call it'), recipe: text('A recipe id from the vocabulary'), roles: roleBindings, params: { type: 'object', description: 'The recipe’s settings' }, timeZone: text('The home’s clock: "Europe/Stockholm"') }, ['name', 'recipe', 'roles', 'params']),
      run: async (args, home) => {
        const input = planInput.parse(args);
        const rule = await home.automations.fromRecipe(input.recipe, input.params);
        let created;
        try {
          // Made by an agent, it is a proposal: only watching, on the timeline as one.
          created = await home.automations.create({ name: input.name, rule, madeFrom: input.recipe, roles: boundOf(input.roles), starts: {}, timeZone: input.timeZone });
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
  const answer = async (message: Json, home: KraftverkApi): Promise<Json | null> => {
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
          return reply({ content: [{ type: 'text', text: await tool.run(params.arguments ?? {}, home) }] });
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
    // The assistant asks as an agent acting for whoever is signed in.
    const home = deps.hub.as({ kind: 'agent', for: actorOf(c) });
    const answers = (await Promise.all(messages.map((message) => answer(message, home)))).filter((reply): reply is Json => reply !== null);
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
