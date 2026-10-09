/*
  A home's modes, as every package says them (docs/PLAN-WORLD-MODEL.md
  §8.10): two axes — whether anyone is home, and the time of day — the
  built-in modes every family has on them, and how any mode's key is made.
  The store keeps them, the file and the automation language name them by
  key, the app shows their names: one list, not one each.
*/

export const MODE_AXES = ['presence', 'day'] as const;

/** A home's two axes of mode: whether anyone is home, and the time of day. */
export type ModeAxis = (typeof MODE_AXES)[number];

/** Each axis, in words. */
export const MODE_AXIS_WORDS: Readonly<Record<ModeAxis, string>> = { presence: 'Whether anyone is home', day: 'The time of day' };

/** A mode's key: lowercase letters, digits and dashes, from a letter — "away", "party", "guests-over". */
export const MODE_KEY = /^[a-z][a-z0-9-]{0,29}$/;

/** A mode, as anything that names one needs it: its key, its axis, its name — "Vacation" — and how a sentence says a home in it: "on vacation". */
export type ModeDefinition = { readonly key: string; readonly axis: ModeAxis; readonly name: string; readonly icon: string; readonly words: string };

/** The modes every family has, in order on each axis; each one's id is its key. */
export const BUILT_IN_MODES: readonly ModeDefinition[] = [
  { key: 'home', axis: 'presence', name: 'Home', icon: 'home', words: 'home' },
  { key: 'away', axis: 'presence', name: 'Away', icon: 'log-out', words: 'away' },
  { key: 'vacation', axis: 'presence', name: 'Vacation', icon: 'sun', words: 'on vacation' },
  { key: 'day', axis: 'day', name: 'Day', icon: 'sun', words: 'day' },
  { key: 'evening', axis: 'day', name: 'Evening', icon: 'sunset', words: 'evening' },
  { key: 'night', axis: 'day', name: 'Night', icon: 'moon', words: 'night' },
];

/** Whether a key is a built-in mode's. */
export const isBuiltInMode = (key: string): boolean => BUILT_IN_MODES.some((mode) => mode.key === key);
