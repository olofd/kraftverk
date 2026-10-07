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
  /**
   * Where a person meets what is on it: among `devices`, among `services`, or
   * on an integration's page — an account, a gateway (`DeviceKind`).
   */
  shelf: 'devices' | 'services' | 'integrations';
};

export const CATEGORIES = {
  'power-station': { label: 'Power stations', singular: 'power station', icon: 'battery-charging', shelf: 'devices' },
  'smart-plug': { label: 'Smart plugs', singular: 'smart plug', icon: 'power', shelf: 'devices' },
  weather: { label: 'Weather', singular: 'weather forecast', icon: 'cloud', shelf: 'services' },
  'energy-price': { label: 'Electricity prices', singular: 'electricity price', icon: 'tag', shelf: 'services' },
  vehicle: { label: 'Vehicles', singular: 'vehicle', icon: 'navigation', shelf: 'devices' },
  // A sign-in to someone's cloud, and what is reached through it: an account and the scooters on it.
  account: { label: 'Accounts', singular: 'account', icon: 'user', shelf: 'integrations' },
  // A device other devices are reached through, on the home network: a Zigbee gateway and the plugs paired with it.
  gateway: { label: 'Gateways', singular: 'gateway', icon: 'share-2', shelf: 'integrations' },
  // Grown toward Home Assistant's breadth (docs/PLAN-INTEGRATIONS.md §4.5): a shelf each, ready for its first type.
  // A relay in a wall box or a DIN rail switching a circuit: not a plug, though it switches as one.
  relay: { label: 'Switches and relays', singular: 'switch', icon: 'toggle-right', shelf: 'devices' },
  light: { label: 'Lights', singular: 'light', icon: 'sun', shelf: 'devices' },
  sensor: { label: 'Sensors', singular: 'sensor', icon: 'activity', shelf: 'devices' },
  climate: { label: 'Heating and cooling', singular: 'thermostat', icon: 'thermometer', shelf: 'devices' },
  lock: { label: 'Locks', singular: 'lock', icon: 'lock', shelf: 'devices' },
  cover: { label: 'Blinds and doors', singular: 'blind or door', icon: 'columns', shelf: 'devices' },
  vacuum: { label: 'Vacuums', singular: 'vacuum', icon: 'disc', shelf: 'devices' },
  camera: { label: 'Cameras', singular: 'camera', icon: 'camera', shelf: 'devices' },
  'media-player': { label: 'TVs and media players', singular: 'media player', icon: 'tv', shelf: 'devices' },
  speaker: { label: 'Speakers', singular: 'speaker', icon: 'speaker', shelf: 'devices' },
  // A person's own device, where it is and how charged: a phone, a watch, a tablet.
  phone: { label: 'Phones and tablets', singular: 'phone', icon: 'smartphone', shelf: 'devices' },
  // Something that only says where it is: a tag on keys, a tracker in a bag.
  tracker: { label: 'Trackers', singular: 'tracker', icon: 'map-pin', shelf: 'devices' },
  // A way to tell people: a push service, a chat.
  notifications: { label: 'Notifications', singular: 'notification service', icon: 'bell', shelf: 'services' },
} as const satisfies Record<string, CategorySpec>;

export type CategoryId = keyof typeof CATEGORIES;

export const CATEGORY_IDS = Object.keys(CATEGORIES) as CategoryId[];

export const isCategory = (id: string): id is CategoryId => Object.hasOwn(CATEGORIES, id);
