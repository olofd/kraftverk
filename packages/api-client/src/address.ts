/*
  A kraftverk server's address, as a person types it and as the app calls it.
  Pure, so it is tested without a screen.
*/

/** An address as it is kept: trimmed, without a trailing slash. */
export const normaliseUrl = (url: string): string => url.trim().replace(/\/+$/, '');

/** A host that is on the home's own network: an IP address, `localhost`, a `.local`/`.lan` name or a name of one label. */
function nearby(host: string): boolean {
  const name = host.replace(/^\[|\]$/g, '').toLowerCase();
  return (
    /^\d{1,3}(\.\d{1,3}){3}$/.test(name) ||
    name.includes(':') ||
    name === 'localhost' ||
    /\.(local|lan|home\.arpa|internal)$/.test(name) ||
    !name.includes('.')
  );
}

/**
 * The addresses what someone typed may mean, the likeliest first.
 *
 * People type `192.168.1.5`, `http://pi.local:3333` or `home.example.net`,
 * and mean the API on it. Requiring the scheme and the `/api` suffix would be
 * a quiz rather than a setup step, so what is missing is filled in — and where
 * it could be either, both are given, to be tried in turn:
 *
 * - a bare host on the home's network is a server on the API's own port,
 *   `port`, over plain HTTP — where a kraftverk server listens unless its owner
 *   moved it;
 * - a bare public name is a server behind a proxy, over HTTPS on its usual
 *   port — the port of the server is not what is reached from the internet;
 * - from a page served over HTTPS (`secure`), HTTPS is tried first whatever
 *   the host: a browser refuses plain HTTP from there.
 *
 * What is typed with its scheme, port or `/api` is taken as it was meant.
 */
export function serverAddresses(input: string, port: number, secure = false): string[] {
  const typed = normaliseUrl(input);
  if (!typed) return [];
  if (/\/api$/i.test(typed) && /^https?:\/\//i.test(typed)) return [typed];

  const scheme = /^(https?):\/\//i.exec(typed)?.[1]?.toLowerCase();
  const rest = scheme ? typed.slice(scheme.length + 3) : typed;
  const slash = rest.indexOf('/');
  const authority = slash < 0 ? rest : rest.slice(0, slash);
  const path = (slash < 0 ? '' : rest.slice(slash)).replace(/\/api$/i, '');
  const withPort = /:\d+$/.test(authority) && !/^\[[^\]]*\]$/.test(authority);
  const host = withPort ? authority.replace(/:\d+$/, '') : authority;

  const plain = `http://${withPort ? authority : `${host}:${port}`}${path}/api`;
  const proxied = `https://${authority}${path}/api`;

  let found: string[];
  if (scheme === 'https') found = [proxied];
  else if (scheme === 'http') found = withPort ? [plain] : [plain, `http://${host}${path}/api`];
  else if (withPort) found = [plain, proxied];
  else found = nearby(host) ? [plain, proxied] : [proxied, plain];

  if (secure) found = [...found.filter((url) => url.startsWith('https:')), ...found.filter((url) => !url.startsWith('https:'))];
  return found;
}

/** The likeliest address of what was typed — the first of `serverAddresses` — or `''` for nothing typed. */
export function completeUrl(input: string, port: number, secure = false): string {
  return serverAddresses(input, port, secure)[0] ?? '';
}

/** A readable default name: the host, which is what tells two servers apart. */
export function suggestName(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'Kraftverk server';
  }
}
