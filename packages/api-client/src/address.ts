/*
  A kraftverk server's address, as a person types it and as the app calls it.
  Pure, so it is tested without a screen.
*/

/** An address as it is kept: trimmed, without a trailing slash. */
export const normaliseUrl = (url: string): string => url.trim().replace(/\/+$/, '');

/**
 * Turns what someone typed into an address that can actually be called.
 *
 * People type `192.168.1.5`, or `http://pi.local:3333`, and mean the API on it.
 * Requiring the scheme and the `/api` suffix would be a quiz rather than a
 * setup step, so both are filled in when they are missing — and a bare host
 * means the API's own port, `port`: where a kraftverk server listens unless
 * its owner moved it, not the port of the page the app was served from.
 */
export function completeUrl(input: string, port: number): string {
  let url = input.trim();
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  url = normaliseUrl(url);
  if (!/\/api$/i.test(url)) {
    if (!/^https?:\/\/[^/]+:\d+/i.test(url)) url = `${url}:${port}`;
    url = `${url}/api`;
  }
  return url;
}

/** A readable default name: the host, which is what tells two servers apart. */
export function suggestName(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'Kraftverk server';
  }
}
