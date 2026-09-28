/**
 * Categories: what a person would call a thing, for finding it.
 *
 * The first screen of adding a device lists these, not device types — "Power
 * stations", "Smart plugs" — because nobody arrives knowing a type id. A
 * category never decides behaviour: that comes from capabilities.
 *
 * A fixed list, so two types cannot spell the same category two ways and split
 * the add screen in half. A new category is a reviewed addition here, the same
 * as a new capability (docs/DATA-MODEL.md §2).
 */

export type CategorySection = 'devices' | 'services';

export type CategorySpec = {
  /** Plural, as a heading: "Power stations". */
  label: string;
  /** Singular, in a sentence: "a power station". */
  singular: string;
  /** A Feather icon name. */
  icon: string;
  section: CategorySection;
  /** One line under the heading. */
  description: string;
};

export const CATEGORIES = {
  'power-station': {
    label: 'Power stations',
    singular: 'power station',
    icon: 'battery-charging',
    section: 'devices',
    description: 'Portable batteries with outlets, charged from mains or solar.',
  },
  'smart-plug': {
    label: 'Smart plugs',
    singular: 'smart plug',
    icon: 'power',
    section: 'devices',
    description: 'Sockets that switch and measure what is plugged into them.',
  },
  weather: {
    label: 'Weather',
    singular: 'weather forecast',
    icon: 'cloud',
    section: 'services',
    description: 'Forecasts for your location, for planning charging around the sun.',
  },
} as const satisfies Record<string, CategorySpec>;

export type CategoryId = keyof typeof CATEGORIES;

export const CATEGORY_IDS = Object.keys(CATEGORIES) as CategoryId[];

export const isCategory = (id: string): id is CategoryId => Object.hasOwn(CATEGORIES, id);
