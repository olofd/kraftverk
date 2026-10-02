import { describe, expect, test } from 'bun:test';

import { ApiError } from './error.ts';

/*
  A refusal crosses a wire — an HTTP body, a message port — and is read back
  as the same refusal: its words, its kind, each problem and the token a yes
  is sent back with. What is not one is not taken for one.
*/

describe('a refusal on the wire', () => {
  test('is read back as it was said', () => {
    const said = new ApiError('needs-yes', 'Turn the heater off?', { problems: ['It draws 900 W'], needsConfirmation: 'yes-token' });
    const read = ApiError.fromWire(JSON.parse(JSON.stringify(said.toWire())));
    expect(read).toBeInstanceOf(ApiError);
    expect([read?.kind, read?.message, read?.problems, read?.needsConfirmation]).toEqual(['needs-yes', 'Turn the heater off?', ['It draws 900 W'], 'yes-token']);
  });

  test('says only what it has', () => {
    expect(new ApiError('not-found', 'No such device').toWire()).toEqual({ error: 'No such device', kind: 'not-found' });
  });

  test('what is not a refusal of a home is not read as one', () => {
    expect(ApiError.fromWire(null)).toBeNull();
    expect(ApiError.fromWire({ error: 'Internal server error' })).toBeNull();
    expect(ApiError.fromWire({ error: 'Gone', kind: 'vanished' })).toBeNull();
  });
});
