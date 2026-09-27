import { describe, expect, test } from 'bun:test';

import { WriteGate, WriteInFlightError } from './writeGate.ts';

/**
 * The races that made controls bounce, replayed step by step.
 *
 * Both were reproduced in the app against a station that did everything right
 * — every write applied at once, no stale frame ever sent — so they are the
 * app's to prevent, and these pin the rule that prevents them.
 */

/** A write the test finishes when it chooses. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('which answers may be shown', () => {
  test('a poll already on its way when the switch is tapped is not shown, however late it lands', async () => {
    const gate = new WriteGate();
    const askedAt = gate.epoch; // the poll goes out: AC is on

    const write = deferred();
    const running = gate.run({ 'port:ac': false }, () => write.promise); // tapped off
    expect(gate.fresh(askedAt)).toBe(false); // the poll lands mid-write: "on" is not shown

    write.resolve();
    await running;
    expect(gate.fresh(askedAt)).toBe(false); // nor if it lands after
  });

  test('a poll asked while a setting is written is not shown when it arrives after the write returned', async () => {
    // The settings bounce: the server answered the poll before the write reached
    // the station, and the answer reached the phone after the write returned.
    const gate = new WriteGate();
    const write = deferred();
    const running = gate.run({ acStandbyMinutes: 960 }, () => write.promise);

    const askedAt = gate.epoch;
    write.resolve();
    await running;

    expect(gate.pending.size).toBe(0);
    expect(gate.fresh(askedAt)).toBe(false);
  });

  test('a poll asked once the write has settled is shown', async () => {
    const gate = new WriteGate();
    await gate.run({ 'port:ac': false }, async () => undefined);
    expect(gate.fresh(gate.epoch)).toBe(true);
  });

  test('with nothing written, every answer is shown', () => {
    const gate = new WriteGate();
    expect(gate.fresh(gate.epoch)).toBe(true);
  });
});

describe('what is pending', () => {
  test('the asked-for value is held until the write settles, and let go when it fails', async () => {
    const gate = new WriteGate();
    const write = deferred();
    const running = gate.run({ 'port:ac': true, chargeLimit: 80 }, () => write.promise);

    expect([...gate.pending]).toEqual([
      ['port:ac', true],
      ['chargeLimit', 80],
    ]);

    write.reject(new Error('The station did not answer'));
    await expect(running).rejects.toThrow('did not answer');
    expect(gate.pending.size).toBe(0);
  });

  test('a second write to the same thing is refused while the first is unconfirmed', async () => {
    const gate = new WriteGate();
    const first = deferred();
    const running = gate.run({ 'port:ac': false }, () => first.promise);

    let sent = false;
    await expect(
      gate.run({ 'port:ac': true }, async () => {
        sent = true;
      })
    ).rejects.toBeInstanceOf(WriteInFlightError);
    expect(sent).toBe(false);
    expect(gate.pending.get('port:ac')).toBe(false);

    // Something else may still be written meanwhile.
    await gate.run({ 'port:usb': true }, async () => undefined);

    first.resolve();
    await running;
  });

  test('the write\'s own answer is what it returns', async () => {
    const gate = new WriteGate();
    expect(await gate.run({ keySound: true }, async () => ({ keySound: true, readBack: true }))).toEqual({
      keySound: true,
      readBack: true,
    });
  });

  test('listeners hear each start and end, and each snapshot is a new object', async () => {
    const gate = new WriteGate();
    const seen: number[] = [];
    const stop = gate.subscribe(() => seen.push(gate.pending.size));
    const before = gate.snapshot();

    await gate.run({ 'port:dc': true }, async () => undefined);
    expect(seen).toEqual([1, 0]);
    expect(gate.snapshot()).not.toBe(before);

    stop();
    await gate.run({ 'port:dc': false }, async () => undefined);
    expect(seen).toEqual([1, 0]);
  });
});
