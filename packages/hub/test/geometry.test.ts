import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { readConfig } from '@kraftverk/home-file';

import { aHome, refusal, type TestHome } from './a-home.ts';

/*
  A home drawn (docs/PLAN-WORLD-MODEL.md §8.5, §8.7): a floor's drawing, a
  room's outline in a frame of its own, a door's place in the wall, and a
  device placed at coordinates — checked, kept, in the file, and back from it.
*/

let t: TestHome;

beforeEach(async () => {
  t = await aHome();
});

afterEach(async () => {
  await t.stop();
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const OUTLINE = [
  [0, 0],
  [4.2, 0],
  [4.2, 3.5],
  [0, 3.5],
] as const;

async function aDrawnHome() {
  const [home] = await t.home.homes.list();
  const site = (await t.home.spaces.list(home!.id)).find((space) => space.kind === 'site')!;
  const drawing = await t.home.media.add({ type: 'image/png', width: 1200, height: 800, data: PNG });
  const floor = await t.home.spaces.add({ parentId: site.id, kind: 'floor', name: 'Ground floor', plan: { pictureId: drawing.id, scale: 0.02, x: -1, y: 12, turn: 0 } });
  const kitchen = await t.home.spaces.add({ parentId: floor.id, kind: 'room', purpose: 'kitchen', name: 'Kitchen', frame: { x: 4, y: 0, turn: 90 }, outline: [...OUTLINE] });
  const door = await t.home.openings.add({ fromId: kitchen.id, toId: null, kind: 'door', name: 'Back door', shape: [[0, 1], [0, 1.9]] });
  return { home: home!, site, drawing, floor, kitchen, door };
}

describe('a home drawn', () => {
  test('a floor’s drawing, a room’s outline in its own frame, a door in the wall: kept as given', async () => {
    const { floor, kitchen, door, drawing } = await aDrawnHome();
    expect(floor.plan).toEqual({ pictureId: drawing.id, scale: 0.02, x: -1, y: 12, turn: 0, width: 1200, height: 800 });
    expect(kitchen.frame).toEqual({ x: 4, y: 0, turn: 90 });
    expect(kitchen.outline).toEqual(OUTLINE.map(([x, y]) => [x, y]));
    expect(door.shape).toEqual([[0, 1], [0, 1.9]]);
    // A turn is kept from 0 up to 360; drawn again, the room's outline is what it is now.
    const turned = await t.home.spaces.update(kitchen.id, { frame: { x: 4, y: 0, turn: -90 }, outline: [[0, 0], [3, 0], [3, 3]] });
    expect(turned.frame!.turn).toBe(270);
    expect(turned.outline).toHaveLength(3);
    expect((await t.home.spaces.update(kitchen.id, { frame: null, outline: null })).outline).toBeNull();
    expect((await t.home.spaces.update(floor.id, { plan: null })).plan).toBeNull();
  });

  test('refused: an outline of two corners, a drawing on a room, one not added first, a point beyond the home', async () => {
    const { kitchen, floor } = await aDrawnHome();
    expect((await refusal(t.home.spaces.update(kitchen.id, { outline: [[0, 0], [1, 1]] }))).message).toBe('An outline has 3 to 200 points');
    expect((await refusal(t.home.spaces.update(kitchen.id, { plan: floor.plan }))).message).toBe('Only a floor has a drawing');
    expect((await refusal(t.home.spaces.update(floor.id, { plan: { pictureId: 'f'.repeat(64), scale: 0.02, x: 0, y: 0, turn: 0 } }))).message).toBe('Add the drawing first: no such picture');
    expect((await refusal(t.home.spaces.update(kitchen.id, { outline: [[0, 0], [5000, 0], [0, 3]] }))).kind).toBe('invalid');
    expect((await refusal(t.home.openings.add({ fromId: kitchen.id, toId: null, kind: 'window', shape: [[0, 0]] }))).message).toBe('Its shape has 2 to 200 points');
  });

  test('in the file, and back from it: the drawing by its picture, the outline, the frame, the door, where the lamp stands', async () => {
    const { kitchen, drawing } = await aDrawnHome();
    t.lampAt('lamp-1');
    const lamp = await t.added('Hall lamp');
    await t.home.devices.place(lamp!.id, { spaceId: kitchen.id, x: 1.5, y: 2, z: 1.1, facing: 90 });
    const { text } = await t.home.configuration.export({ secrets: 'none' });
    const document = readConfig(text).document!;
    const home = Object.values(document.homes)[0]!;
    const floor = home.spaces.find((space) => space.kind === 'floor')!;
    expect(floor.plan).toEqual({ picture: drawing.id, scale: 0.02, x: -1, y: 12, turn: 0 });
    expect(floor.spaces[0]).toMatchObject({ key: 'kitchen', frame: { x: 4, y: 0, turn: 90 }, outline: OUTLINE.map(([x, y]) => [x, y]) });
    expect(Object.values(home.openings)[0]!.shape).toEqual([[0, 1], [0, 1.9]]);
    expect(Object.values(document.devices).find((device) => device.name === lamp!.name)!.place).toMatchObject({ space: 'kitchen', at: [1.5, 2], height: 1.1, facing: 90 });

    // Moved and redrawn here; the file brings it back as it was.
    await t.home.spaces.update(kitchen.id, { outline: [[0, 0], [1, 0], [1, 1]], frame: null });
    await t.home.devices.place(lamp!.id, { spaceId: kitchen.id });
    const plan = await t.home.configuration.plan({ text });
    expect(plan.homes.flatMap((each) => each.changes).join(' ')).toContain('spaces changed: Kitchen');
    await t.home.configuration.apply({ plan: plan.id! });
    const back = (await t.home.spaces.list(kitchen.homeId)).find((space) => space.id === kitchen.id)!;
    expect([back.frame, back.outline]).toEqual([{ x: 4, y: 0, turn: 90 }, OUTLINE.map(([x, y]) => [x, y])]);
    expect((await t.home.devices.get(lamp!.id)).placement).toMatchObject({ x: 1.5, y: 2, z: 1.1, facing: 90 });
  });
});
