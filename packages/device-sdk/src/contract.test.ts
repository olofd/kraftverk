import { describe, expect, test } from 'bun:test';

import { isSimulated, methodOf, methodsOf, platformsOf, SIMULATED_METHOD, SIMULATED_METHOD_ID, SIMULATED_TRANSPORT } from './connection.ts';
import { MAIN_PART, type DeviceDescription } from './description.ts';
import type { DeviceContext, DeviceSession, DeviceType } from './device-type.ts';
import { defineDeviceType, describeDeviceType } from './device-type.ts';
import { unmetNeed, type NodeNeeds, type Platform } from './node.ts';
import type { Protocol } from './protocol.ts';
import { setupPlan } from './setup.ts';
import { checkDeviceTypeContract, fakeByteChannel, fakeConnection } from './testing.ts';
import type { TransportDefinition } from './transport.ts';
import { connectionProblems, validateDeviceType, validateProtocol, validateTransportDefinition } from './validate.ts';

/*
  A plug small enough to read in one sitting, reached by a made-up protocol
  over the home network, used to prove the contract suite: that it passes a
  type that keeps its promises, and catches each way a type can break them.
*/

type PlugConfig = { pollSeconds: number };

function simulatedPlug(ctx: DeviceContext<PlugConfig>, flaws: { refuse?: boolean; lie?: boolean } = {}): DeviceSession {
  let on = true;
  let at = new Date().toISOString();
  let watts = 40;

  ctx.schedule(10, () => {
    at = new Date().toISOString();
    watts = on ? 40 + Math.round(Math.random() * 5) : 0;
  });

  return {
    health: () => ({ status: 'connected', detail: 'Simulated', lastReadingAt: at }),
    readings: () => [
      { key: 'watts', value: watts, at },
      { key: 'relay', value: on, at },
      ...(flaws.lie ? [{ key: 'secret', value: 1, at }] : []),
    ],
    async command(request) {
      if (flaws.refuse) return { accepted: false, error: 'Not today' };
      if (request.capability !== 'switch' || typeof request.args.on !== 'boolean') return { accepted: false, error: 'Unknown command' };
      on = request.args.on;
      at = new Date().toISOString();
      return { accepted: true };
    },
    close: async () => undefined,
  };
}

const encoder = new TextEncoder();

const decoder = new TextDecoder();

const PLUG: DeviceDescription = {
  parts: [{ id: MAIN_PART, label: 'Example plug', kind: 'device', offers: ['switch'] }],
  attributes: [
    { key: 'watts', label: 'Power', value: { type: 'number', unit: 'W' }, quantity: 'power', means: 'power.draw', category: 'primary' },
    { key: 'relay', label: 'Relay', value: { type: 'boolean' }, means: 'switch.on' },
  ],
};

const plug = (flaws: Parameters<typeof simulatedPlug>[1] = {}, description: DeviceDescription = PLUG): DeviceType<PlugConfig> =>
  defineDeviceType<PlugConfig>({
    id: 'example.plug',
    kind: 'hardware',
    meta: { name: 'Example plug', category: 'smart-plug', support: 'experimental', icon: 'power' },
    config: { fields: { pollSeconds: { type: 'number', title: 'Poll interval', default: 10, min: 1 } } },
    connections: [{ id: 'lan', label: 'Home network', protocol: 'example', transport: 'lan', reach: 'local' }],
    describe: () => description,
    // Asks the plug who it is: it answers "id:<serial>".
    async identify(connection) {
      if (connection.channel.kind !== 'bytes') throw new Error('Expected bytes');
      const channel = connection.channel;
      const answer = await new Promise<string>((resolve) => {
        const stop = channel.onData((bytes) => {
          stop();
          resolve(decoder.decode(bytes));
        });
        void channel.write(encoder.encode('who?'));
      });
      return { identity: `example:${answer.slice(3)}`, model: 'Example', summary: 'It answered.' };
    },
    createSession: async (ctx) => simulatedPlug(ctx, flaws),
    createSimulator: async (ctx) => simulatedPlug(ctx, flaws),
  });

const connection = () =>
  fakeConnection({
    method: 'lan',
    protocol: 'example',
    transport: 'lan',
    address: '192.0.2.10',
    channel: fakeByteChannel((bytes) => (decoder.decode(bytes) === 'who?' ? encoder.encode('id:0042') : null)),
  });

const exampleProtocol: Protocol = {
  id: 'example',
  label: 'Example',
  bindings: {
    lan: {
      open: () => ({ port: 9999 }),
      recognise: (sighting) => (sighting.facts.example ? { name: 'Example plug' } : null),
      instructions: { title: 'Plug it in', body: 'Join it to the network that {host} is on.' },
      parseAddress: (input) => (/^[0-9.]+$/.test(input) ? input : null),
      addressLabel: 'IP address',
    },
  },
  credentials: { schema: { fields: { key: { type: 'string', presentation: 'secret', title: 'Key', required: true } } } },
};

const lan: TransportDefinition = {
  id: 'lan',
  label: 'the home network',
  channel: 'bytes',
  exclusive: true,
  nearby: false,
  platforms: ['system', 'native'],
  discovery: { system: 'list', native: 'list' },
};

describe('the contract suite', () => {
  test('passes a type that keeps its promises, and says who the device is', async () => {
    expect(await checkDeviceTypeContract(plug(), { settleMs: 500, connections: [connection] })).toEqual([]);
  });

  test('catches a part that offers a switch but will not switch', async () => {
    const problems = await checkDeviceTypeContract(plug({ refuse: true }), { settleMs: 200 });
    expect(problems).toContain('main: switch.set was refused by the simulator: Not today');
  });

  test('catches a reading its description does not have', async () => {
    const problems = await checkDeviceTypeContract(plug({ lie: true }), { settleMs: 200 });
    expect(problems).toContain('reports "secret", which the description does not have');
  });

  test('catches an identity that is not namespaced by its protocol', async () => {
    const type = plug();
    const liar = { ...type, identify: async () => ({ identity: '0042', model: null, summary: 'Hello' }) };
    expect(await checkDeviceTypeContract(liar, { settleMs: 200, connections: [connection] })).toContain(
      'identify over lan: identity "0042" is not namespaced by its protocol "example"'
    );
  });
});

describe('validating a declaration', () => {
  const broken = (change: (type: DeviceType<PlugConfig>) => DeviceType<any>) => validateDeviceType(change(plug()));

  test('a good one has nothing to say', () => {
    expect(validateDeviceType(plug())).toEqual([]);
  });

  test('ids are namespaced', () => {
    expect(broken((type) => ({ ...type, id: 'plug' }))).toEqual(['id "plug" must be namespaced lowercase, like "brand.model"']);
  });

  test('where a way can be held follows from its transport’s runtimes, and what it needs of the node holding it', () => {
    const radio = { platforms: ['system', 'web', 'native'] as Platform[] };
    const own = plug().connections[0]!;
    expect(platformsOf(SIMULATED_METHOD, null)).toEqual(['system', 'web', 'native']);
    expect(platformsOf({ ...own, transport: 'radio' }, radio)).toEqual(['system', 'web', 'native']);
    // A transport nothing installed provides runs nowhere.
    expect(platformsOf({ ...own, transport: 'gone' }, null)).toEqual([]);

    const kept = { ...own, needs: { trusted: 'its account stays at home' } };
    const phone = { alwaysOn: false, reachable: false, trusted: false };
    expect(unmetNeed(kept, phone)).toEqual({ trait: 'trusted', why: 'its account stays at home' });
    expect(unmetNeed(kept, { ...phone, trusted: true })).toBeNull();
    expect(unmetNeed(own, phone)).toBeNull();
    expect(broken((type) => ({ ...type, connections: [{ ...own, needs: { roomy: 'why' } as NodeNeeds }] }))).toEqual([
      `connection method "${own.id}" needs "roomy" of a node, which no node declares: alwaysOn, reachable, trusted`,
    ]);
    expect(broken((type) => ({ ...type, connections: [{ ...own, needs: { trusted: ' ' } }] }))).toEqual([`connection method "${own.id}" needs "trusted" of a node without saying why`]);
  });

  test('simulated is every type’s own way, and no type declares it', () => {
    const type = plug();
    expect(methodsOf(type).map((method) => method.id)).toEqual([...type.connections.map((method) => method.id), SIMULATED_METHOD_ID]);
    expect(methodOf(type, SIMULATED_METHOD_ID)).toBe(SIMULATED_METHOD);
    expect(isSimulated(SIMULATED_METHOD)).toBe(true);
    expect(describeDeviceType(type).connections.at(-1)).toMatchObject({ id: 'simulated', label: 'Simulated' });

    const own = type.connections[0]!;
    expect(broken((candidate) => ({ ...candidate, connections: [{ ...own, id: SIMULATED_METHOD_ID }] }))).toContain(
      'connection method id "simulated" is every type\'s own: its simulator'
    );
    expect(broken((candidate) => ({ ...candidate, connections: [{ ...own, transport: SIMULATED_TRANSPORT }] }))).toContain(
      `connection method "${own.id}" goes over "sim", which only the simulated method may`
    );
    expect(validateTransportDefinition({ id: 'sim', label: 'pretend', channel: 'bytes', platforms: ['system'], discovery: {} } as never)).toContain(
      'transport id "sim" is taken: it means simulated'
    );
  });

  test('a category comes from the fixed list; which section it is listed in is the type’s kind', () => {
    expect(broken((type) => ({ ...type, meta: { ...type.meta, category: 'smartplug' as never } }))[0]).toContain(
      'meta.category "smartplug" is not one of'
    );
    expect(broken((type) => ({ ...type, meta: { ...type.meta, category: 'weather' } }))).toEqual([]);
  });

  test('every way to reach a device says what it needs beyond the home network', () => {
    expect(broken((type) => ({ ...type, connections: type.connections.map(({ reach: _reach, ...method }) => method as never) }))).toContain(
      'connection method "lan" must say what it reaches: local, cloud-at-setup, cloud'
    );
  });

  test('the shared vocabulary’s namespace is not a type’s', () => {
    expect(broken((type) => ({ ...type, id: 'standard.plug' }))).toContain('id "standard.plug" is in the namespace "standard", which is the shared vocabulary\'s');
  });

  test('a tool is declared as data: what it answers, in the value system', () => {
    expect(
      broken((type) => ({ ...type, tools: { dump: { label: 'Dump', description: 'Everything.', writes: false, answer: { type: 'list', of: { type: 'object', fields: {} } } } } }))
    ).toContain('tool "dump" answer[] is an object with no fields');
    expect(broken((type) => ({ ...type, tools: { dump: { label: 'Dump', description: 'Everything.', writes: false, honoursReadOnly: true, answer: { type: 'boolean' } } } }))).toContain(
      'tool "dump" honours read-only mode but never writes'
    );
  });

  const described = (change: (description: DeviceDescription) => DeviceDescription) => validateDeviceType(plug({}, change(PLUG)));

  test('a capability outside the library is refused', () => {
    expect(described((d) => ({ ...d, parts: [{ id: MAIN_PART, label: 'Plug', kind: 'device', offers: ['switch', 'teleport' as never] }] }))).toContain(
      'part "main" offers "teleport", which is neither in the library nor declared by the type'
    );
  });

  test('a part that offers a capability has the attributes it needs', () => {
    expect(described((d) => ({ ...d, attributes: d.attributes.filter((attribute) => attribute.means !== 'switch.on') }))).toContain(
      'part "main" offers "switch", which needs an attribute meaning "switch.on"'
    );
  });

  test('a standard meaning keeps its standard unit, so devices can share an axis', () => {
    const problems = described((d) => ({
      ...d,
      attributes: d.attributes.map((attribute) => (attribute.key === 'watts' ? { ...attribute, value: { type: 'number', unit: 'kW' } } : attribute)),
    }));
    expect(problems).toContain('attribute "watts" means power.draw, which is power in "W"');
  });

  test('a device can be reached some way', () => {
    expect(broken((type) => ({ ...type, connections: [] }))).toContain('a device type needs at least one connection method');
  });

  test('secrets are never config: they are a connection\'s credentials', () => {
    expect(
      broken((type) => ({ ...type, config: { fields: { ...type.config.fields, key: { type: 'string', presentation: 'secret', title: 'Key' } } } }))
    ).toContain('config field "key" is a secret; secrets belong to a connection\'s credentials');
  });

  test('a setup form for the device asks only for fields in its config', () => {
    expect(
      broken((type) => ({
        ...type,
        setup: { steps: [{ id: 'where', kind: 'form', target: 'device', title: 'Where?', schema: { fields: { room: { type: 'string', title: 'Room' } } } }] },
      }))
    ).toContain('setup step "where" asks for "room", which is not in config');
  });

  test('the core\'s own step names are not a type\'s to take', () => {
    expect(
      broken((type) => ({ ...type, setup: { steps: [{ id: 'check', kind: 'instructions', title: 'X', body: 'Y' }] } }))
    ).toContain('setup step "check" is declared twice, or uses a name the core reserves');
  });
});

describe('what only an installation can check', () => {
  const installed = (protocols: Protocol[], transports: TransportDefinition[]) => ({
    protocol: (id: string) => protocols.find((p) => p.id === id) ?? null,
    transport: (id: string) => transports.find((t) => t.id === id) ?? null,
  });

  test('a method needs its protocol and transport installed, and a binding between them', () => {
    expect(connectionProblems(plug(), installed([exampleProtocol], [lan]))).toEqual([]);
    expect(connectionProblems(plug(), installed([], [lan]))).toEqual([
      'connection method "lan" speaks "example", which is not installed',
    ]);
    const unbound = { ...exampleProtocol, bindings: {} };
    expect(connectionProblems(plug(), installed([unbound], [lan]))).toEqual([
      'connection method "lan": "example" has no binding for "lan"',
    ]);
  });

  test('protocols and transports are checked too', () => {
    expect(validateProtocol(exampleProtocol)).toEqual([]);
    expect(validateProtocol({ ...exampleProtocol, bindings: {} })).toEqual(['protocol "example" has no binding to any transport']);
    expect(validateTransportDefinition(lan)).toEqual([]);
    expect(validateTransportDefinition({ ...lan, platforms: [] })).toEqual(['transport "lan" runs nowhere']);
  });
});

test('a method\'s setup is assembled from its layers, and sent without functions', () => {
  const type = plug();
  const steps = setupPlan({
    type,
    method: type.connections[0]!,
    protocol: exampleProtocol,
    transport: lan,
    platform: 'system',
    values: { host: '192.0.2.5' },
  });
  expect(steps.map((step) => `${step.id}:${step.kind}`)).toEqual([
    'ready:instructions',
    'choose:choose',
    'credentials:form',
    'check:check',
  ]);
  expect(steps[0]).toMatchObject({ body: 'Join it to the network that 192.0.2.5 is on.' });
  expect(steps[1]).toMatchObject({ discovery: 'list', manual: 'IP address', transport: 'lan' });
  expect(JSON.parse(JSON.stringify(steps))).toEqual(steps);
});
