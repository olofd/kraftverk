/**
 * Categories: what a person would call a thing, for finding it.
 *
 * The first screen of adding a device lists these, not device types — "Power
 * stations", "Smart plugs" — because nobody arrives knowing a type id. A
 * category never decides behaviour: that comes from capabilities. Nor does it
 * decide the section of the add screen: that comes from each type's `kind`,
 * hardware, service or account.
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
  // A sign-in to someone's cloud, and what is reached through it: an account and the scooters on it.
  account: { label: 'Accounts', singular: 'account', icon: 'user' },
  // A device other devices are reached through, on the home network: a Zigbee gateway and the plugs paired with it.
  gateway: { label: 'Gateways', singular: 'gateway', icon: 'share-2' },
  // Grown toward Home Assistant's breadth (docs/PLAN-INTEGRATIONS.md §4.5): a shelf each, ready for its first type.
  light: { label: 'Lights', singular: 'light', icon: 'sun' },
  sensor: { label: 'Sensors', singular: 'sensor', icon: 'activity' },
  climate: { label: 'Heating and cooling', singular: 'thermostat', icon: 'thermometer' },
  lock: { label: 'Locks', singular: 'lock', icon: 'lock' },
  cover: { label: 'Blinds and doors', singular: 'blind or door', icon: 'columns' },
  vacuum: { label: 'Vacuums', singular: 'vacuum', icon: 'disc' },
  camera: { label: 'Cameras', singular: 'camera', icon: 'camera' },
  'media-player': { label: 'TVs and media players', singular: 'media player', icon: 'tv' },
  speaker: { label: 'Speakers', singular: 'speaker', icon: 'speaker' },
  // A person's own device, where it is and how charged: a phone, a watch, a tablet.
  phone: { label: 'Phones and tablets', singular: 'phone', icon: 'smartphone' },
  // Something that only says where it is: a tag on keys, a tracker in a bag.
  tracker: { label: 'Trackers', singular: 'tracker', icon: 'map-pin' },
  // A way to tell people: a push service, a chat.
  notifications: { label: 'Notifications', singular: 'notification service', icon: 'bell' },
} as const satisfies Record<string, CategorySpec>;

export type CategoryId = keyof typeof CATEGORIES;

export const CATEGORY_IDS = Object.keys(CATEGORIES) as CategoryId[];

export const isCategory = (id: string): id is CategoryId => Object.hasOwn(CATEGORIES, id);
