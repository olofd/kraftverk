import { afterEach, describe, expect, test } from 'bun:test';

import type { NeedsYouView } from '@kraftverk/api-contract';

import { aHome, type TestHome } from './a-home.ts';

/*
  Discovery by declaration (docs/PLAN-INTEGRATIONS.md §4.4, step 12): a way
  says what it is found by, a sighting is matched against that as data, its
  protocol confirms — and what is found and not yours waits on you, without
  anyone opening the add screen, wherever watching costs nothing.
*/

let home: TestHome;
afterEach(async () => {
  await home.stop();
});

const said = (items: readonly NeedsYouView[]) => items.map((item) => (item.kind === 'act' ? ['act', item.device.name] : ['found', item.found.address]));

describe('found without asking', () => {
  test('a transport that costs nothing to watch is watched from the start, and what turns up on it waits on you', async () => {
    home = await aHome({ background: true });
    home.lampAt('lamp-1');
    expect(home.bus.watchers).toBe(0);
    home.hub.nearby.start();
    expect(home.bus.watchers).toBe(1);

    const items = await home.home.needsYou();
    expect(said(items)).toEqual([['found', 'lamp-1']]);
    const found = items[0]!.kind === 'found' ? items[0]!.found : null;
    // Its protocol read who it is from what it announced, and each way that is found by it is offered.
    expect(found).toMatchObject({ transport: 'bus', protocol: 'test-lamp', identity: 'test-lamp:LAMP-1', name: 'Lamp lamp-1' });
    expect(found?.types.map((type) => type.methodId)).toEqual(['bus', 'backup']);
  });

  test('a radio that must scan is watched only when someone asks', async () => {
    home = await aHome();
    home.lampAt('lamp-1');
    home.hub.nearby.start();
    expect(home.bus.watchers).toBe(0);
    expect((await home.home.nearby()).map((entry) => entry.address)).toEqual(['lamp-1']);
    expect(home.bus.watchers).toBe(1);
  });

  test('one said not to be yours does not wait on you', async () => {
    home = await aHome({ background: true });
    home.lampAt('lamp-1');
    home.lampAt('lamp-2');
    home.hub.nearby.start();
    await home.home.ignoreFound({ transport: 'bus', through: null, address: 'lamp-2' });
    expect(said(await home.home.needsYou())).toEqual([['found', 'lamp-1']]);
    expect((await home.home.nearby()).find((entry) => entry.address === 'lamp-2')?.ignored).toBe(true);
  });
});

describe('what is yours is not found again', () => {
  test('at its own address, or at another one it moved to', async () => {
    home = await aHome({ background: true });
    home.lampAt('lamp-1');
    home.hub.nearby.start();
    await home.added('Hall lamp');
    expect(said(await home.home.needsYou())).toEqual([]);

    // The router gave it another address: the same lamp, by what it announces, not a new one.
    home.bus.lamps.delete('lamp-1');
    home.lampAt('lamp-9', { serial: 'LAMP-1' });
    home.lampAt('lamp-2');
    expect((await home.home.nearby()).map((entry) => entry.address)).toEqual(['lamp-2']);
  });
});
