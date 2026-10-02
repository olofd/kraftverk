/*
  The key a device or an automation is known by (docs/DATA-MODEL.md,
  docs/CONFIG.md): a column of the data model — what a configuration file,
  an import and a link name it by — so it is the SDK's, which the file format
  and the stores both depend on.
*/

/** A key: lowercase letters, digits and dashes, starting with a letter or digit. */
export const KEY = /^[a-z0-9][a-z0-9-]{0,62}$/;

/*
  What the names of things a package declares look like, checked by one set
  of patterns wherever they are checked — a type's id, a part, an attribute,
  a capability, a role, a recipe.
*/

/** One word or several, lowercase, joined by dashes: a namespace, an icon, a plain id. */
export const PLAIN_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/** Plain ids joined by dots, two at least: a type's id ("brand.model"), a part's kind of a type's own. */
export const NAMESPACED_ID = /^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+(-[a-z0-9]+)*)+$/;
/** Plain ids joined by dots, one at least: a part ("outlet.ac", "main"). */
export const PART_ID = /^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+(-[a-z0-9]+)*)*$/;
/** A device's own key for what it reports, as its vendor names it: letters, digits, dots, dashes and underscores. */
export const ATTRIBUTE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** A name in camelCase: a role, a command, a tool, a capability's last word. */
export const CAMEL_NAME = /^[a-z][A-Za-z0-9]*$/;
/** A capability of a type's own: its namespace, then a camelCase name ("acme.station.chargeLimit"). */
export const NAMESPACED_NAME = /^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+(-[a-z0-9]+)*)+\.[a-z][A-Za-z0-9]*$/;
/** What a package brings to automations: its namespace, then a name in camelCase or with dashes ("acme.weather.forecast-switch"). */
export const CONTRIBUTED_ID = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z][A-Za-z0-9-]*$/;

/**
 * A key from a name, for something you have just named: "Garage Station 2" is
 * `garage-station-2`, "Laddare för skotern" `laddare-for-skotern` — and, when
 * `taken` says one is someone else's, `-2`, `-3` after it.
 */
export function keyFrom(name: string, taken: (key: string) => boolean, fallback = 'item'): string {
  const base =
    name
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      // Room for "-99" after it, within a key's 63.
      .slice(0, 56)
      .replace(/-+$/, '') || fallback;
  if (!taken(base)) return base;
  for (let n = 2; ; n++) if (!taken(`${base}-${n}`)) return `${base}-${n}`;
}

/**
 * A name a file can carry: what it is about, and when — "Start charging
 * 2026-10-01 09-50-22.csv". The same wherever a file is made: the server's
 * download, or the app's.
 */
export const fileNameOf = (about: string, at: string, extension: string): string =>
  `${about.replace(/[^\p{L}\p{N} _-]+/gu, '').trim() || 'kraftverk'} ${at.slice(0, 19).replace('T', ' ').replace(/:/g, '-')}.${extension}`;
