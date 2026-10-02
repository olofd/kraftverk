/*
  The document's version, and the way from each to the next (docs/CONFIG.md).

  The configuration is the one thing in kraftverk versioned on purpose: the
  database is evergreen and set aside on any change to its schema, and the
  configuration is what carries a home across that. So a document written
  by an older kraftverk is read by every newer one: `kraftverk: n` at its
  top, and each change to the document's shape adds `MIGRATIONS[n]`, taking
  a version-n document to n + 1, with a kept fixture of version n to test
  it against.
*/

/** The version this kraftverk writes. */
export const CURRENT_VERSION = 1;

/** Each version's document, as data, made into the next version's. */
export const MIGRATIONS: Readonly<Record<number, (document: Record<string, unknown>) => Record<string, unknown>>> = {};

export type Migrated = { ok: true; document: Record<string, unknown>; from: number } | { ok: false; message: string };

/** A document of any version this kraftverk can read, brought to the current one. */
export function migrate(document: Record<string, unknown>): Migrated {
  const version = document.kraftverk;
  if (version === undefined) return { ok: false, message: `The document says which version it is: "kraftverk: ${CURRENT_VERSION}" at its top` };
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) return { ok: false, message: '"kraftverk" is the document\'s version: a whole number' };
  if (version > CURRENT_VERSION) return { ok: false, message: `It was written by a newer kraftverk (version ${version}); this one reads up to version ${CURRENT_VERSION}` };
  let migrated = document;
  for (let at = version; at < CURRENT_VERSION; at++) {
    const step = MIGRATIONS[at];
    if (!step) return { ok: false, message: `There is no way from version ${at} to ${at + 1}` };
    migrated = { ...step(migrated), kraftverk: at + 1 };
  }
  return { ok: true, document: migrated, from: version };
}
