import { describe, expect, test } from 'bun:test';

import type { DeviceContext, DeviceSession, DeviceType } from './device-type.ts';
import { defineDeviceType } from './device-type.ts';
import { describeSetup } from './setup.ts';
import { checkDeviceTypeContract } from './testing.ts';
import { validateDeviceType } from './validate.ts';

/*
  A plug small enough to read in one sitting, used to prove the contract
  suite: that it passes a type that keeps its promises, and catches each way
  a type can break them.
*/

type PlugConfig = { host: string; pollSeconds: number };

function simulatedPlug(ctx: DeviceContext<PlugConfig>, flaws: { dropSwitch?: boolean; lie?: boolean } = {}): DeviceSession {
  let on = true;
  let at = new Date().toISOString();
  let watts = 40;

  ctx.schedule(10, () => {
    at = new Date().toISOString();
    watts = on ? 40 + Math.round(Math.random() * 5) : 0;
  });

  return {
    health: () => ({ status: 'connected', detail: 'Simulated', owner: 'server', transport: 'sim', lastReadingAt: at }),
    readings: () => [
      { key: 'watts', value: watts, at },
      { key: 'relay', value: on, at },
      ...(flaws.lie ? [{ key: 'secret', value: 1, at }] : []),
    ],
    capability: ((name: string) => {
      if (name === 'switch' && !flaws.dropSwitch) {
        return {
          state: () => ({ on, at }),
          set: async (next: boolean) => {
            on = next;
            at = new Date().toISOString();
            return { accepted: true as const };
          },
          bootBehaviour: () => 'unknown' as const,
        };
      }
      if (name === 'powerMeter') return { read: () => ({ watts, at }) };
      return null;
    }) as DeviceSession['capability'],
    close: async () => undefined,
  };
}

const plug = (flaws: Parameters<typeof simulatedPlug>[1] = {}): DeviceType<PlugConfig> =>
  defineDeviceType<PlugConfig>({
    id: 'example.plug',
    apiVersion: '2',
    kind: 'hardware',
    meta: { name: 'Example plug', category: 'smart-plug', support: 'experimental', icon: 'power' },
    protocols: ['example'],
    capabilities: ['switch', 'powerMeter'],
    telemetry: [
      { key: 'watts', label: 'Power', unit: 'W', kind: 'power', metric: 'power.draw', primary: true },
      { key: 'relay', label: 'Relay', unit: '', kind: 'state', metric: 'switch.on' },
    ],
    controls: [{ id: 'relay', label: 'Relay', kind: 'switch', capability: 'switch', measurementKey: 'relay' }],
    config: {
      fields: {
        host: { type: 'host', title: 'Address', required: true },
        pollSeconds: { type: 'number', title: 'Poll interval', default: 10, min: 1 },
      },
    },
    setup: {
      steps: [
        { id: 'where', kind: 'form', title: 'Where is it?', fields: ['host'] },
        { id: 'read', kind: 'verify', title: 'Read it once', run: async () => ({ ok: true, detail: 'It answered' }) },
      ],
    },
    createSession: async (ctx) => simulatedPlug(ctx, flaws),
    createSimulator: async (ctx) => simulatedPlug(ctx, flaws),
  });

describe('the contract suite', () => {
  test('passes a type that keeps its promises', async () => {
    expect(await checkDeviceTypeContract(plug(), { config: { host: '192.0.2.10' }, settleMs: 500 })).toEqual([]);
  });

  test('catches a capability that is declared but not offered', async () => {
    const problems = await checkDeviceTypeContract(plug({ dropSwitch: true }), { config: { host: '192.0.2.10' }, settleMs: 200 });
    expect(problems).toContain('declares "switch" but the session does not offer it');
  });

  test('catches telemetry that was never declared', async () => {
    const problems = await checkDeviceTypeContract(plug({ lie: true }), { config: { host: '192.0.2.10' }, settleMs: 200 });
    expect(problems).toContain('reports "secret", which its telemetry does not declare');
  });
});

describe('validating a declaration', () => {
  const broken = (change: (type: DeviceType<PlugConfig>) => DeviceType<any>) => validateDeviceType(change(plug()));

  test('a good one has nothing to say', () => {
    expect(validateDeviceType(plug())).toEqual([]);
  });

  test('ids are namespaced', () => {
    expect(broken((type) => ({ ...type, id: 'plug' }))).toEqual([
      'id "plug" must be namespaced lowercase, like "brand.model"',
    ]);
  });

  test('a capability outside the library is refused', () => {
    expect(broken((type) => ({ ...type, capabilities: [...type.capabilities, 'teleport' as never] }))).toContain(
      'capability "teleport" is not in the library'
    );
  });

  test('a capability brings the telemetry it needs', () => {
    expect(
      broken((type) => ({ ...type, telemetry: type.telemetry.filter((spec) => spec.metric !== 'switch.on'), controls: [] }))
    ).toContain('capability "switch" needs telemetry with metric "switch.on"');
  });

  test('a standard metric keeps its standard unit, so devices can share an axis', () => {
    const problems = broken((type) => ({
      ...type,
      telemetry: type.telemetry.map((spec) => (spec.key === 'watts' ? { ...spec, unit: 'kW' } : spec)),
    }));
    expect(problems[0]).toContain('claims power.draw, which is power in "W"');
  });

  test('a type\'s own metric may not squat in a standard namespace', () => {
    const problems = broken((type) => ({
      ...type,
      telemetry: [...type.telemetry, { key: 'hz', label: 'Hz', unit: 'Hz', kind: 'frequency', metric: 'power.hz' }],
    }));
    expect(problems[0]).toContain('metric "power.hz" on "hz" is not a standard id');
  });

  test('a control uses a command its capability has', () => {
    expect(
      broken((type) => ({ ...type, controls: [{ id: 'x', label: 'X', kind: 'button', capability: 'powerMeter' }] }))
    ).toContain('control "x": "powerMeter" has no command "set"');
  });

  test('a setup form asks only for fields in config', () => {
    expect(
      broken((type) => ({
        ...type,
        setup: { steps: [{ id: 'f', kind: 'form', title: 'F', fields: ['password'] }, ...type.setup.steps.slice(1)] },
      }))
    ).toContain('setup step "f" asks for "password", which is not in config');
  });

  test('every setup guide can prove the device works', () => {
    expect(broken((type) => ({ ...type, setup: { steps: type.setup.steps.slice(0, 1) } }))).toContain(
      'the setup guide has no verify step'
    );
  });
});

test('the app is sent setup steps without their functions', () => {
  const steps = describeSetup(plug().setup);
  expect(steps).toEqual([
    { id: 'where', kind: 'form', title: 'Where is it?', fields: ['host'], actions: [] },
    { id: 'read', kind: 'verify', title: 'Read it once', saveAnyway: null },
  ]);
  expect(JSON.parse(JSON.stringify(steps))).toEqual(steps);
});
