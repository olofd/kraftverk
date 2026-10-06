import { afterEach, describe, expect, test } from 'bun:test';

import { aHome, refusal, type TestHome } from './a-home.ts';

/*
  A bridge's members, as a person adds them (docs/PLAN-INTEGRATIONS.md §4.3):
  offered as found, chosen from the bridge's own list, read once over it,
  saved as a way through it — and, offered or not, ignored and brought back.
  Through the home's interface, as the server's routes and an app ask it.
*/

let home: TestHome;
afterEach(async () => {
  await home.stop();
});

/** The hub, added the simulated way: an account whose simulator brings two lamps. */
const withHub = async () => {
  home = await aHome({ bridges: true });
  const hub = await home.added('Hub', { typeId: 'test.hub', methodId: 'simulated' });
  return hub.id;
};

describe('what waits on a person', () => {
  test('a bridge whose sign-in is refused is listed once — not each device behind it, which says why — beside what is found behind it', async () => {
    const hub = await withHub();
    const draft = await home.home.setup.start({ typeId: 'test.relayed-lamp', methodId: 'hub' });
    await home.home.setup.choose(draft.id, { address: 'lamp-a' });
    await home.home.setup.check(draft.id);
    const lamp = await home.home.setup.save(draft.id, { name: 'Lamp A' });

    expect((await home.home.needsYou()).map((item) => (item.kind === 'act' ? ['act', item.device.name] : ['found', item.found.address]))).toEqual([['found', 'lamp-b']]);

    home.bridged.needsYou = 'The hub refused its PIN: give it again on its page';
    const items = await home.home.needsYou();
    expect(items.filter((item) => item.kind === 'act')).toEqual([{ kind: 'act', device: { id: hub, name: 'Hub', kind: 'account', integration: { id: 'test', name: 'Test' } }, detail: 'The hub refused its PIN: give it again on its page' }]);
    // The lamp behind it says it waits too, in the hub's words.
    expect((await home.home.devices.get(lamp.id)).health).toMatchObject({ status: 'needs-you', detail: 'Hub: The hub refused its PIN: give it again on its page' });
    home.bridged.needsYou = undefined;
  });
});

describe('members of a bridge', () => {
  test('are found near you through it, each as the type the bridge says it is', async () => {
    const hub = await withHub();
    const found = (await home.home.nearby()).filter((each) => each.through);
    expect(found.map((each) => [each.address, each.name, each.through, each.ignored, each.types.map((type) => type.typeId)])).toEqual([
      ['lamp-a', 'Lamp A', { id: hub, name: 'Hub' }, false, ['test.relayed-lamp']],
      ['lamp-b', 'Lamp B', { id: hub, name: 'Hub' }, false, ['test.relayed-lamp']],
    ]);
  });

  test('are chosen from the bridge, read over it, and saved as a way through it — then opened through it', async () => {
    const hub = await withHub();
    const draft = await home.home.setup.start({ typeId: 'test.relayed-lamp', methodId: 'hub' });
    expect(draft.through).toBe(hub);
    expect(draft.plan.find((step) => step.kind === 'choose')).toMatchObject({ transport: 'bridge', discovery: 'list', manual: null });

    const sightings = await home.home.setup.sightings(draft.id);
    expect(sightings.map((sighting) => [sighting.address, sighting.through?.name, sighting.claimedBy])).toEqual([
      ['lamp-a', 'Hub', null],
      ['lamp-b', 'Hub', null],
    ]);
    await home.home.setup.choose(draft.id, { address: 'lamp-a' });
    expect(await home.home.setup.check(draft.id)).toMatchObject({ outcome: 'new' });
    const lamp = await home.home.setup.save(draft.id, { name: 'Lamp A' });

    expect(lamp.connections).toEqual([expect.objectContaining({ transport: 'bridge', address: 'lamp-a', through: { id: hub, key: 'hub', name: 'Hub' }, heldBy: expect.objectContaining({ kind: 'master' }) })]);
    expect(home.hub.sessions.get(lamp.id)).not.toBeNull();
    // Switched through the hub, as any device is: through the gateway.
    await home.home.devices.command(lamp.id, 'main', 'switch', 'set', { args: { on: true } });
    expect(home.bridged.lamps.get('lamp-a')!.on).toBe(true);

    // What is added is no longer found; the other still is.
    expect((await home.home.nearby()).filter((each) => each.through).map((each) => each.address)).toEqual(['lamp-b']);
    // Chosen again, it is yours.
    const again = await home.home.setup.start({ typeId: 'test.relayed-lamp', methodId: 'hub' });
    await home.home.setup.choose(again.id, { address: 'lamp-a' });
    expect(await home.home.setup.check(again.id)).toMatchObject({ outcome: 'yours', device: { id: lamp.id } });
  });

  test('cannot be set up while no bridge it goes through is open here', async () => {
    home = await aHome({ bridges: true });
    const refused = await refusal(home.home.setup.start({ typeId: 'test.relayed-lamp', methodId: 'hub' }));
    expect(refused.message).toBe('A Relayed lamp is reached through Test hub: add that first, or open it here');
  });

  test('a way through a bridge goes in the file by the bridge\'s key, and comes back through it, the bridge written first', async () => {
    const hub = await withHub();
    const draft = await home.home.setup.start({ typeId: 'test.relayed-lamp', methodId: 'hub' });
    await home.home.setup.choose(draft.id, { address: 'lamp-a' });
    await home.home.setup.check(draft.id);
    await home.home.setup.save(draft.id, { name: 'Lamp A' });
    const hubKey = (await home.home.devices.get(hub)).key;

    const { text } = await home.home.configuration.export({ secrets: 'none' });
    expect(text).toContain(`      - via: hub\n        through: ${hubKey}\n        address: lamp-a`);

    // Into a home that has neither: the lamp is written after the hub it goes through, whatever the file's order.
    const reordered = text.replace(/^(devices:\n)([\s\S]*?)(^links:|^automations:|^secrets:|$(?![\s\S]))/m, (_whole, head: string, body: string, tail: string) => {
      const entries = body.split(/(?=^ {2}[a-z0-9-]+:\n)/m);
      return head + [...entries].reverse().join('') + tail;
    });
    const fresh = await aHome({ bridges: true });
    try {
      const plan = await fresh.home.configuration.plan({ text: reordered });
      expect(plan.problems).toEqual([]);
      await fresh.home.configuration.apply({ plan: plan.id! });
      const lamp = (await fresh.home.devices.list()).find((device) => device.name === 'Lamp A')!;
      const newHub = (await fresh.home.devices.list()).find((device) => device.name === 'Hub')!;
      expect(lamp.connections).toEqual([expect.objectContaining({ transport: 'bridge', address: 'lamp-a', through: { id: newHub.id, key: hubKey, name: 'Hub' } })]);
      expect(fresh.hub.sessions.get(lamp.id)).not.toBeNull();
    } finally {
      await fresh.stop();
    }
  });

  test('found ones can be ignored, and brought back: listed apart, never lost', async () => {
    const hub = await withHub();
    const at = { transport: 'bridge', through: hub, address: 'lamp-b' };
    await home.home.ignoreFound(at);
    const ignored = (await home.home.nearby()).find((each) => each.address === 'lamp-b');
    expect(ignored?.ignored).toBe(true);
    expect((await home.home.nearby()).find((each) => each.address === 'lamp-a')?.ignored).toBe(false);
    await home.home.unignoreFound(at);
    expect((await home.home.nearby()).find((each) => each.address === 'lamp-b')?.ignored).toBe(false);
  });
});
