import { describe, expect, test } from 'bun:test';

import { completeUrl, normaliseUrl, serverAddresses, suggestName } from './address.ts';

describe('a server’s address', () => {
  test('what is typed is completed: the scheme, the API’s own port for a host nearby, and /api', () => {
    expect(completeUrl('192.0.2.5', 3333)).toBe('http://192.0.2.5:3333/api');
    expect(completeUrl('pi.local', 3333)).toBe('http://pi.local:3333/api');
    expect(completeUrl(' http://pi.local:8080/ ', 3333)).toBe('http://pi.local:8080/api');
    expect(completeUrl('https://home.example.net/api/', 3333)).toBe('https://home.example.net/api');
    expect(completeUrl('   ', 3333)).toBe('');
  });

  test('a public name is a server behind a proxy: HTTPS on its usual port first, never the API’s port alone', () => {
    expect(serverAddresses('home.example.net', 3333)).toEqual([
      'https://home.example.net/api',
      'http://home.example.net:3333/api',
    ]);
    expect(serverAddresses('https://home.example.net', 3333)).toEqual(['https://home.example.net/api']);
    expect(serverAddresses('home.example.net/kraftverk', 3333)[0]).toBe('https://home.example.net/kraftverk/api');
  });

  test('where it could be either, both are tried; from a secure page HTTPS first', () => {
    expect(serverAddresses('192.0.2.5', 3333)).toEqual(['http://192.0.2.5:3333/api', 'https://192.0.2.5/api']);
    expect(serverAddresses('192.0.2.5', 3333, true)).toEqual(['https://192.0.2.5/api', 'http://192.0.2.5:3333/api']);
    expect(serverAddresses('http://pi.local', 3333)).toEqual(['http://pi.local:3333/api', 'http://pi.local/api']);
    expect(serverAddresses('192.0.2.5:8080', 3333)).toEqual(['http://192.0.2.5:8080/api', 'https://192.0.2.5:8080/api']);
  });

  test('kept without a trailing slash, and named by its host', () => {
    expect(normaliseUrl(' http://192.0.2.5:3333/api// ')).toBe('http://192.0.2.5:3333/api');
    expect(suggestName('http://192.0.2.5:3333/api')).toBe('192.0.2.5:3333');
    expect(suggestName('not an address')).toBe('Kraftverk server');
  });
});
