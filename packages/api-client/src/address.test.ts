import { describe, expect, test } from 'bun:test';

import { completeUrl, normaliseUrl, suggestName } from './address.ts';

describe('a server’s address', () => {
  test('what is typed is completed: the scheme, the API’s own port for a bare host, and /api', () => {
    expect(completeUrl('192.0.2.5', 3333)).toBe('http://192.0.2.5:3333/api');
    expect(completeUrl(' http://pi.local:8080/ ', 3333)).toBe('http://pi.local:8080/api');
    expect(completeUrl('https://home.example.net/api/', 3333)).toBe('https://home.example.net/api');
    expect(completeUrl('   ', 3333)).toBe('');
  });

  test('kept without a trailing slash, and named by its host', () => {
    expect(normaliseUrl(' http://192.0.2.5:3333/api// ')).toBe('http://192.0.2.5:3333/api');
    expect(suggestName('http://192.0.2.5:3333/api')).toBe('192.0.2.5:3333');
    expect(suggestName('not an address')).toBe('Kraftverk server');
  });
});
