/*
  The key a device or an automation is known by (docs/DATA-MODEL.md,
  docs/CONFIG.md): a column of the data model — what a configuration file,
  an import and a link name it by — so it is the SDK's, which the file format
  and the stores both depend on.
*/

/** A key: lowercase letters, digits and dashes, starting with a letter or digit. */
export const KEY = /^[a-z0-9][a-z0-9-]{0,62}$/;

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
      .slice(0, 56)
      .replace(/-+$/, '') || fallback;
  if (!taken(base)) return base;
  for (let n = 2; ; n++) if (!taken(`${base}-${n}`)) return `${base}-${n}`;
}
