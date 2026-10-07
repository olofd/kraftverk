/*
  The cookies Apple's sign-in and iCloud set, kept: `fetch` keeps none
  between requests, and Apple's session lives in them as much as in its
  headers (X-APPLE-WEBAUTH-TOKEN and the rest). Each by the domain it was
  set for, sent only to that domain and those under it; as plain data, so a
  session keeps them between runs.
*/

/** One cookie: its name and value, the domain it is sent to, and until when (ms; none: for the session). */
export type Cookie = { name: string; value: string; domain: string; expires?: number };

/** The cookies a response sets: each `Set-Cookie`, read for its name, value, domain and lifetime. */
export function cookiesSet(headers: Headers, host: string, now = Date.now()): Cookie[] {
  // Each Set-Cookie apart where the platform keeps them so; one header joined by commas where it does not.
  const each = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  const lines: string[] = typeof each === 'function' ? each.call(headers) : (headers.get('set-cookie') ?? '').split(/,(?=\s*[A-Za-z0-9_.-]+=)/);
  const cookies: Cookie[] = [];
  for (const line of lines) {
    const [pair, ...attributes] = line.split(';');
    const equals = pair?.indexOf('=') ?? -1;
    if (!pair || equals <= 0) continue;
    const cookie: Cookie = { name: pair.slice(0, equals).trim(), value: pair.slice(equals + 1).trim(), domain: host.toLowerCase() };
    for (const attribute of attributes) {
      const [key, value = ''] = attribute.split('=').map((part: string) => part.trim());
      switch (key?.toLowerCase()) {
        case 'domain':
          cookie.domain = value.replace(/^\./, '').toLowerCase();
          break;
        case 'max-age':
          cookie.expires = now + Number(value) * 1000;
          break;
        case 'expires':
          if (cookie.expires === undefined && Number.isFinite(Date.parse(value))) cookie.expires = Date.parse(value);
          break;
      }
    }
    cookies.push(cookie);
  }
  return cookies;
}

/** What a jar holds after a response: what it set replaces what was, and what it expired is gone. */
export function keep(jar: readonly Cookie[], set: readonly Cookie[], now = Date.now()): Cookie[] {
  const same = (a: Cookie, b: Cookie) => a.name === b.name && a.domain === b.domain;
  const kept = jar.filter((cookie) => !set.some((each) => same(each, cookie)));
  return [...kept, ...set].filter((cookie) => cookie.value !== '' && (cookie.expires === undefined || cookie.expires > now));
}

/** The `Cookie` header for a host: every cookie of its domain, or of a domain it is under. */
export function cookieHeader(jar: readonly Cookie[], host: string, now = Date.now()): string | null {
  const name = host.toLowerCase();
  const sent = jar.filter((cookie) => (name === cookie.domain || name.endsWith(`.${cookie.domain}`)) && (cookie.expires === undefined || cookie.expires > now));
  return sent.length ? sent.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ') : null;
}
