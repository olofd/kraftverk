/*
  Which type a reported model is: the one rule for it, wherever a model is
  matched — the check step judging a device it read, an account or a gateway
  offering what is behind it.
*/

/** Whether a model name a type claims covers what a device reports: as it, or with a finish after it — "X2 Sport Black (Matte)". */
export function coversModel(model: string, reported: string): boolean {
  const [name, said] = [model.trim().toLowerCase(), reported.trim().toLowerCase()];
  return said === name || said.startsWith(`${name} `);
}

/** How closely a type's model names cover a reported model: the longest that does, or 0 when none does. */
export function modelCloseness(models: readonly string[] | undefined, reported: string): number {
  return Math.max(0, ...(models ?? []).filter((model) => coversModel(model, reported)).map((model) => model.trim().length));
}
