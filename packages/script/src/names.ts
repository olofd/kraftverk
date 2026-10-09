/*
  What a script calls the family's things (docs/PLAN-SCRIPTS.md §6): each
  person, home, room and device by a name it can write — `family.maria`,
  `homes.cabin.rooms.kitchen`, `devices.garagePlug`. One rule, used where the
  types are made (types.ts) and inside the sandbox (guest/sdk.ts), so what
  the editor completes is what runs.
*/

/** A word a script can write for a name or a key: "Garage plug" and "garage-plug" are `garagePlug`, "Åsa" is `asa`. */
function scriptName(text: string): string {
  const words = text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  const name = words.map((word, at) => (at === 0 ? word.charAt(0).toLowerCase() + word.slice(1) : word.charAt(0).toUpperCase() + word.slice(1))).join('');
  if (!name) return 'unnamed';
  return /^[0-9]/.test(name) ? `_${name}` : name;
}

/** Each of several things named, in the order given: the second Maria is `maria2`. */
export function scriptNames(texts: readonly string[]): string[] {
  const taken = new Set<string>();
  return texts.map((text) => {
    const name = scriptName(text);
    let given = name;
    for (let at = 2; taken.has(given); at++) given = `${name}${at}`;
    taken.add(given);
    return given;
  });
}
