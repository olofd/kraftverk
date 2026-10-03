import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { answerMcp, worldText } from '../src/index.ts';
import { aHome, type TestHome } from './a-home.ts';

/*
  The house for an assistant (PROPOSITION.md §5.1–5.3), asked of the home:
  the world as a model reads it, the words it is said in, and the MCP tools
  (`answerMcp`) — each asking the home as an agent acting for a person, so
  what needs that person's yes is refused it, in the gateway's words.
*/

let t: TestHome;
beforeEach(async () => {
  t = await aHome();
});
afterEach(async () => {
  await t.stop();
});

const SERVER = { name: 'kraftverk', version: '0.0.0-test' };
/** One MCP message, answered as the assistant acting for olof. */
const mcp = (method: string, params: Record<string, unknown> = {}, id: number | null = 1) =>
  answerMcp({ jsonrpc: '2.0', ...(id === null ? {} : { id }), method, params }, t.hub.as({ kind: 'agent', for: 'olof' }), SERVER);
const tool = async (name: string, args: Record<string, unknown> = {}) => ((await mcp('tools/call', { name, arguments: args }))!.result as { content: { text: string }[]; isError?: boolean });

describe('an assistant', () => {
  test('reads the world: every device, its parts, what each offers and reports, and whether it is current', async () => {
    const station = await t.added('Garage station', { typeId: 'test.station' });
    const world = await t.home.world();
    expect(world.rules.length).toBeGreaterThan(0);
    const mains = world.devices.find((device) => device.id === station.id)!.parts.find((part) => part.id === 'input.ac')!;
    expect(mains).toMatchObject({ kind: 'input', capabilities: ['acInput'] });
    expect(mains.values).toContainEqual(expect.objectContaining({ key: 'input.ac.present', means: 'grid.present', current: true }));
    // The same, a few lines a device, for a context window.
    const text = worldText(world);
    expect(text).toContain(`Garage station [${station.id}] Test station: connected`);
    expect(text).toContain('input.ac "Mains" input offers acInput');
  });

  test('reads the words it is said in: capabilities with what makes a command consequential, and the recipes', async () => {
    const words = await t.home.vocabulary();
    expect(words.capabilities.switch!.commands.set!.consequential).toMatchObject({ when: { arg: 'on', is: false } });
    expect(words.meanings['battery.soc']).toEqual({ label: 'Charge', type: 'number', unit: '%' });
    expect(words.recipes.map((recipe) => recipe.id)).toContain('standard.charge-between');
    expect(words.policy.loadWatts).toMatchObject({ value: 5, unit: 'W' });
  });

  test('speaks MCP: the handshake, its tools, and nothing for a notification or a tool it does not have', async () => {
    const hello = await mcp('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    expect(hello!.result).toMatchObject({ serverInfo: SERVER, capabilities: { tools: {} } });
    // A notification is heard, and not answered.
    expect(await mcp('notifications/initialized', {}, null)).toBeNull();
    const names = ((await mcp('tools/list'))!.result as { tools: { name: string }[] }).tools.map((listed) => listed.name);
    expect(names).toEqual(['world', 'vocabulary', 'command', 'query', 'receipts', 'rehearse', 'automations', 'start', 'stop', 'propose']);
    expect((await mcp('tools/call', { name: 'rm -rf' }))!.error).toMatchObject({ code: -32602 });
    expect((await mcp('resources/list'))!.error).toMatchObject({ code: -32601 });
  });

  test('a fault inside kraftverk is said as one, not in its own words — a refusal is said as it is', async () => {
    const failing = new Proxy(t.hub.as({ kind: 'agent', for: 'olof' }), {
      get: (home, key) => (key === 'world' ? () => Promise.reject(new Error('SQLITE_ERROR near SELECT pin FROM connection_secret')) : Reflect.get(home, key)),
    });
    const said = (await answerMcp({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'world', arguments: {} } }, failing, SERVER))!.result as { content: { text: string }[]; isError: boolean };
    expect(said.isError).toBe(true);
    expect(said.content[0]!.text).toBe('The tool world failed inside kraftverk; the server\'s log says why.');
  });

  test('a tool’s arguments are held to the schema it advertises: one missing or one it does not take is refused, saying which', async () => {
    const plug = await t.added('Heater plug', { typeId: 'test.plug' });
    const missing = await tool('command', { device: plug.id, part: 'main', capability: 'switch', command: 'set', args: { on: true } });
    expect(missing.isError).toBe(true);
    expect(missing.content[0]!.text).toBe('reason: is needed');
    const unknown = await tool('receipts', { device: plug.id, everything: true });
    expect(unknown.isError).toBe(true);
    expect(unknown.content[0]!.text).toBe('everything: is not one of its arguments');
    const wrongType = await tool('receipts', { limit: 'all' });
    expect(wrongType).toMatchObject({ isError: true, content: [{ text: 'limit: should be integer' }] });
    // What every object has is no argument of a tool.
    expect(await tool('receipts', { constructor: 1 })).toMatchObject({ isError: true, content: [{ text: 'constructor: is not one of its arguments' }] });
    expect((await mcp('tools/call', { name: 'receipts', arguments: 'all' }))!.error).toMatchObject({ code: -32602 });
  });

  test('commands through the gateway as an agent: what needs a person’s yes is left to the person, and the timeline says who asked', async () => {
    const plug = await t.added('Heater plug', { typeId: 'test.plug' });
    const command = (on: boolean) => tool('command', { device: plug.id, part: 'main', capability: 'switch', command: 'set', args: { on }, reason: 'asked to' });

    // Off, while it draws 240 W: a person's to do.
    const refused = await command(false);
    expect(refused.content[0]!.text).toBe('refused: A person has to do this, in the app: it needs their confirmation. Power is 240 W.');
    // A made-up argument is a refusal with a sentence, never a wrong device.
    expect((await tool('command', { device: plug.id, part: 'main', capability: 'switch', command: 'set', args: { on: 'maybe' }, reason: 'x' })).content[0]!.text).toContain('refused: on must be');

    const receipts = (await tool('receipts', { device: plug.id })).content[0]!.text;
    expect(receipts).toContain('command.refused by assistant for olof');
  });

  test('proposes an automation from a recipe: made watching, said as a sentence, rehearsed on history', async () => {
    const station = await t.added('Garage station', { typeId: 'test.station' });
    const plug = await t.added('Charger plug', { typeId: 'test.plug' });
    const roles = { battery: { device: station.id, part: 'main' }, charger: { device: plug.id, part: 'main' } };
    const proposal = await tool('propose', { name: 'My charge window', recipe: 'standard.charge-between', roles, params: { low: 15, high: 50, minutes: 2 }, timeZone: 'Europe/Stockholm' });
    expect(proposal.isError).toBeUndefined();
    expect(proposal.content[0]!.text).toContain(
      'only watching: When Garage station’s charge is below 15 % for 2 min, or when Garage station’s charge is at least 50 %, turn Charger plug on if Garage station’s charge is below 50 %, off if not.'
    );
    expect(proposal.content[0]!.text).toContain('It acts on its own only once a person lets it, in the app');
    expect(proposal.content[0]!.text).toContain('Rehearsed from');
    // Copied from the recipe: its own rule, its settings written into its blocks.
    const made = await t.home.automations.list();
    expect(made).toEqual([expect.objectContaining({ name: 'My charge window', mode: 'watch', rule: expect.objectContaining({ params: { fields: {} } }), madeFrom: expect.objectContaining({ id: 'standard.charge-between' }) })]);

    // A setting outside its range is refused, with the reason, and nothing is made.
    const wrong = await tool('propose', { name: 'Wrong', recipe: 'standard.charge-between', roles, params: { low: 1 } });
    expect(wrong.isError).toBe(true);
    expect(await t.home.automations.list()).toHaveLength(1);
  });
});
