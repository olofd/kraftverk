import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { aHome, refusal, type TestHome } from './a-home.ts';

/*
  Scripts, asked of a home (docs/PLAN-SCRIPTS.md). A script read on an
  engine is the engine's to test (@kraftverk/script-wasm), and end to end
  with a server and without one (e2e/scripts.e2e.ts); here, what a home
  with no engine says.
*/

let t: TestHome;
beforeEach(async () => {
  t = await aHome();
});
afterEach(async () => {
  await t.stop();
});

describe('a script', () => {
  test('is not read where no engine runs scripts, and the home says so', async () => {
    const refused = await refusal(t.home.scripts.check("import { fn, t } from 'kraftverk';\nexport const one = fn({ returns: t.number() }, () => 1);\n"));
    expect(refused).toMatchObject({ kind: 'unavailable', message: 'Scripts cannot run here: this place has no engine for them' });
  });
});
