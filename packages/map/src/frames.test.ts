import { describe, expect, test } from 'bun:test';

import { between, drawingCorners, fromGlobe, globeToSite, inside, siteToGlobe, spaceAt, toGlobe, toSite, turned, type Anchor, type FramedSpace, type Point } from './frames.ts';

/*
  Frames: a home's metres, turned and moved up its tree of spaces, and onto
  the Earth by its place and bearing — and back again.
*/

const close = (a: readonly number[], b: readonly number[], digits = 6) => a.forEach((value, at) => expect(value).toBeCloseTo(b[at]!, digits));

const ANCHOR: Anchor = { latitude: 59.33, longitude: 18.07, bearing: 0 };
type Drawn = FramedSpace & { outline: Point[] | null };
const SPACES: Drawn[] = [
  { id: 'site', parentId: null, frame: null, outline: null },
  { id: 'house', parentId: 'site', frame: { x: 10, y: 20, turn: 90 }, outline: null },
  { id: 'ground', parentId: 'house', frame: null, outline: [[0, 0], [10, 0], [10, 8], [0, 8]] },
  {
    id: 'kitchen',
    parentId: 'ground',
    frame: { x: 4, y: 0, turn: 0 },
    outline: [
      [0, 0],
      [4, 0],
      [4, 3],
      [0, 3],
    ],
  },
];

describe('frames', () => {
  test('turned clockwise, as a compass: north becomes east', () => {
    close(turned([0, 1], 90), [1, 0]);
    close(turned([1, 0], 90), [0, -1]);
    close(turned(turned([3, 4], 37), -37), [3, 4]);
  });

  test('a point in a room is in the site’s frame by its floor and its building, and comes back', () => {
    // The kitchen's corner is 4 m along the house's x, which is turned to point south of the site's.
    close(toSite(SPACES, 'kitchen', [0, 0]), [10, 16]);
    close(toSite(SPACES, 'kitchen', [1, 1]), [11, 15]);
    close(between(SPACES, 'site', 'kitchen', toSite(SPACES, 'kitchen', [2.5, 1.5])), [2.5, 1.5]);
  });

  test('on the Earth: a metre north is a metre north; a turned site turns too; and back', () => {
    const [, north] = siteToGlobe(ANCHOR, [0, 111.195]);
    expect(north - ANCHOR.latitude).toBeCloseTo(0.001, 5);
    const turnedHome = { ...ANCHOR, bearing: 90 };
    const [east, same] = siteToGlobe(turnedHome, [0, 100]);
    expect(east).toBeGreaterThan(ANCHOR.longitude);
    expect(same).toBeCloseTo(ANCHOR.latitude, 9);
    close(globeToSite(turnedHome, siteToGlobe(turnedHome, [12, -7])), [12, -7]);
    close(fromGlobe(ANCHOR, SPACES, 'kitchen', toGlobe(ANCHOR, SPACES, 'kitchen', [3, 2])), [3, 2]);
  });

  test('a floor’s drawing: its corners, its pixels running right and down from where it is placed', () => {
    const [topLeft, topRight, bottomRight, bottomLeft] = drawingCorners(ANCHOR, SPACES, 'site', { scale: 0.01, x: 0, y: 0, turn: 0, width: 1000, height: 500 });
    close(globeToSite(ANCHOR, topLeft), [0, 0]);
    close(globeToSite(ANCHOR, topRight), [10, 0]);
    close(globeToSite(ANCHOR, bottomRight), [10, -5]);
    close(globeToSite(ANCHOR, bottomLeft), [0, -5]);
  });

  test('inside an outline, on its edge too; and the innermost drawn space a point is in', () => {
    const square: Point[] = [
      [0, 0],
      [2, 0],
      [2, 2],
      [0, 2],
    ];
    expect(inside([1, 1], square)).toBe(true);
    expect(inside([2, 1], square)).toBe(true);
    expect(inside([3, 1], square)).toBe(false);
    expect(spaceAt(SPACES, 'site', toSite(SPACES, 'kitchen', [1, 1]))?.id).toBe('kitchen');
    expect(spaceAt(SPACES, 'site', toSite(SPACES, 'ground', [1, 6]))?.id).toBe('ground');
    expect(spaceAt(SPACES, 'site', [-50, -50])).toBeNull();
  });
});
