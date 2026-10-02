import { describe, expect, test } from 'bun:test';

import { ASKED_AGAIN, wantsYes, withConfirmation, type Question } from './confirm.ts';

describe('a person’s yes', () => {
  test('one shape wants it, whatever answered: a token and why — a gateway’s verdict says why in its detail', () => {
    expect(wantsYes({ needsConfirmation: 't-1', reason: 'It draws 240 W' })).toEqual({ token: 't-1', reason: 'It draws 240 W' });
    expect(wantsYes({ outcome: 'refused', detail: 'It feeds the station', needsConfirmation: 't-2' })).toEqual({ token: 't-2', reason: 'It feeds the station' });
    expect(wantsYes({ outcome: 'verified', detail: 'Done' })).toBeNull();
  });

  test('asked for as long as it is wanted — the second time saying the first yes no longer counted — and sent with each yes', async () => {
    const sent: (string | undefined)[] = [];
    const asked: Question[] = [];
    const answers = [{ needsConfirmation: 'a', reason: 'Why' }, { needsConfirmation: 'b', reason: 'Why now' }, { done: true }];
    const { answer, declined } = await withConfirmation(
      async (confirmation) => (sent.push(confirmation), answers.shift()!),
      (reason) => ({ title: 'Sure?', message: reason, yes: 'Yes' }),
      async (question) => (asked.push(question), true)
    );
    expect(declined).toBe(false);
    expect(answer).toEqual({ done: true });
    expect(sent).toEqual([undefined, 'a', 'b']);
    expect(asked.map((question) => question.message)).toEqual(['Why', `${ASKED_AGAIN}\n\nWhy now`]);
  });

  test('a no is the last answer, and nothing more is sent', async () => {
    let sends = 0;
    const { answer, declined } = await withConfirmation(
      async () => (sends++, { needsConfirmation: 'a', reason: 'Why' }),
      (reason) => ({ title: 'Sure?', message: reason, yes: 'Yes' }),
      async () => false
    );
    expect(declined).toBe(true);
    expect(answer).toEqual({ needsConfirmation: 'a', reason: 'Why' });
    expect(sends).toBe(1);
  });
});
