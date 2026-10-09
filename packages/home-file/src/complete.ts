/*
  What an editor offers where a map of the configuration file is not yet
  begun (docs/CONFIG.md): the keys its JSON Schema (schema.ts) takes there,
  as what is written chooses among its alternatives — a step's `run script`
  choosing that script's step, and so its inputs under `with`. Pure: the
  editor finds where the cursor is and what is written; this says what may
  go there.
*/

type Schema = Record<string, unknown>;

/** A key a map may take, as an editor offers it: its name, its title and words, and what it is when not given. */
export type KeyOffered = { name: string; title: string | null; description: string | null; fallback: unknown };

/** A schema, its references followed: `#/$defs/step`. */
function resolved(root: Schema, schema: unknown): Schema | null {
  let at = schema;
  for (let hops = 0; at && typeof at === 'object' && typeof (at as Schema).$ref === 'string' && hops < 20; hops++) {
    const path = ((at as Schema).$ref as string).replace(/^#\//, '').split('/');
    at = path.reduce<unknown>((into, key) => (into && typeof into === 'object' ? (into as Schema)[key] : undefined), root);
  }
  return at && typeof at === 'object' ? (at as Schema) : null;
}

/** Whether an alternative may be what a value is: what it fixes — a const, a list of values — agrees with what the value says, and it has no key the alternative does not take. */
function fits(root: Schema, schema: Schema, value: unknown): boolean {
  const properties = schema.properties as Record<string, unknown> | undefined;
  if (!properties || !value || typeof value !== 'object' || Array.isArray(value)) return true;
  const given = value as Record<string, unknown>;
  if (schema.additionalProperties === false && Object.keys(given).some((key) => !(key in properties))) return false;
  return Object.entries(properties).every(([key, each]) => {
    const property = resolved(root, each);
    if (given[key] === undefined || !property) return true;
    if ('const' in property) return property.const === given[key];
    if (Array.isArray(property.enum)) return property.enum.includes(given[key]);
    return true;
  });
}

/** The alternatives a value may be, of a schema: each anyOf or oneOf that fits it, all the way down. */
function alternatives(root: Schema, schema: unknown, value: unknown): Schema[] {
  const own = resolved(root, schema);
  if (!own) return [];
  const list = (own.anyOf ?? own.oneOf) as unknown[] | undefined;
  if (!Array.isArray(list)) return [own];
  return list.flatMap((each) => {
    const one = resolved(root, each);
    return one && fits(root, one, value) ? alternatives(root, one, value) : [];
  });
}

/**
 * The keys the map at a JSON pointer may take, as the data written chooses
 * the schema there: each once, with what is written beside its reference —
 * its title, its default — over what the reference holds.
 */
export function keysOffered(schema: object, pointer: string, data: unknown): KeyOffered[] {
  const root = schema as Schema;
  let schemas = alternatives(root, root, data);
  let value = data;
  for (const key of pointer.split('/').slice(1).map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))) {
    const next = schemas.flatMap((each) => {
      const child = Array.isArray(value) ? each.items : ((each.properties as Record<string, unknown> | undefined)?.[key] ?? (typeof each.additionalProperties === 'object' ? each.additionalProperties : undefined));
      return child ? [child] : [];
    });
    value = value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
    schemas = next.flatMap((each) => alternatives(root, each, value));
  }
  const offered = new Map<string, KeyOffered>();
  for (const each of schemas) {
    for (const [name, written] of Object.entries((each.properties as Record<string, unknown> | undefined) ?? {})) {
      if (offered.has(name)) continue;
      const property = { ...resolved(root, written), ...(written as Schema) };
      offered.set(name, { name, title: typeof property.title === 'string' ? property.title : null, description: typeof property.description === 'string' ? property.description : null, fallback: property.default });
    }
  }
  return [...offered.values()];
}
