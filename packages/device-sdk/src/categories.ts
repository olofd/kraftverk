/**
 * Categories: what a person would call a thing, for finding it.
 *
 * The first screen of adding a device lists these, not device types — "Power
 * stations", "Smart plugs" — because nobody arrives knowing a type id. A
 * category never decides behaviour: that comes from capabilities. Nor does it
 * decide the section of the add screen: that comes from each type's `kind`,
 * hardware or service.
 *
 * A category is a shelf, so it says nothing about any one product; what a
 * product is, its package says in its own description. A fixed list, so two
 * types cannot spell the same category two ways and split the add screen in
 * half. A new one is a reviewed addition here: a plural label, a singular one
 * that reads in a sentence ("a power station"), and a Feather icon.
 */

export type CategorySpec = {
  /** Plural, as a heading: "Power stations". */
  label: string;
  /** Singular, in a sentence: "a power station". */
  singular: string;
  /** A Feather icon name. */
  icon: string;
};

export const CATEGORIES = {
  'power-station': { label: 'Power stations', singular: 'power station', icon: 'battery-charging' },
  'smart-plug': { label: 'Smart plugs', singular: 'smart plug', icon: 'power' },
  weather: { label: 'Weather', singular: 'weather forecast', icon: 'cloud' },
  'energy-price': { label: 'Electricity prices', singular: 'electricity price', icon: 'tag' },
  vehicle: { label: 'Vehicles', singular: 'vehicle', icon: 'navigation' },
} as const satisfies Record<string, CategorySpec>;

export type CategoryId = keyof typeof CATEGORIES;

export const CATEGORY_IDS = Object.keys(CATEGORIES) as CategoryId[];

export const isCategory = (id: string): id is CategoryId => Object.hasOwn(CATEGORIES, id);
