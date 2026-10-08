/*
  The app's addresses: every page, and every step of a flow, has one of its
  own — so a page can be reloaded, linked to and gone back to, and a setup
  in progress is taken up again where it was. Collections are plural, a
  thing is its id under them, what belongs to it under that:

    /                                       Home
    /devices/add                            Add a device: its shelves
    /devices/add/<category>                 what is on one
    /services/add[/<category>]              Add a service, the same way
    /add/<type>                             how it is reached
    /setup/<draft>/<step>                   a setup in progress, one step
    /devices/<id>[/settings|/tools]         a device
    /devices/<id>/parts/<part>
    /devices/<id>/ways/add                  another way to reach it
    /devices/<id>/ways/<connection>/again   one way set up again
    /devices/removed
    /automations[/new]
    /automations/<id>[/edit[?view=yaml]|/configuration]
    /automations/<id>/runs/<run>
    /integrations/<id>
    /integrations/<id>/accounts/<account>   an integration's own: an account,
    /integrations/<id>/gateways/<gateway>   or a gateway
    /problems
    /family[/<person>]                      where everyone is, and one person
    /notifications                          your inbox
    /settings[/accounts|/connectivity|/configuration|/server-log|/maps|/homes[/<id>]|/zones[/<id>]|/labels|/people|/join]

  Built here and nowhere else: a screen asks for an address, it never
  spells one.
*/

import type { DeviceKind } from '@kraftverk/device-sdk';

const at = encodeURIComponent;

/** `?a=1&b=2` of what is given; nothing when nothing is. */
function query(values: Readonly<Record<string, string | null | undefined | false>>): string {
  const given = Object.entries(values).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== '');
  return given.length ? `?${given.map(([name, value]) => `${name}=${at(value)}`).join('&')}` : '';
}

/**
 * What a setup carries through its steps: where "Found near you" found it
 * (`method`, `address`, `through`), the device another way is added to
 * (`attach`), for a way this app holds for its server `held: here`, and —
 * for an account or a gateway set up because a device needs it — the type
 * to go back to adding once it is saved (`then`).
 */
export type SetupFrom = { method?: string; address?: string; through?: string; attach?: string; held?: 'here'; then?: string };

export const PATHS = {
  home: '/',

  /** What you were told: your inbox. */
  notifications: '/notifications',

  family: {
    /** Where everyone is: the family's map, and each in words. */
    list: '/family',
    person: (id: string) => `/family/${at(id)}`,
  },

  devices: {
    add: (category?: string) => (category ? `/devices/add/${at(category)}` : '/devices/add'),
    removed: '/devices/removed',
    one: (id: string) => `/devices/${at(id)}`,
    settings: (id: string) => `/devices/${at(id)}/settings`,
    tools: (id: string) => `/devices/${at(id)}/tools`,
    part: (id: string, part: string) => `/devices/${at(id)}/parts/${at(part)}`,
    /** Another way to reach a device you have. */
    addWay: (id: string) => `/devices/${at(id)}/ways/add`,
    /** One of its ways set up again: signed in again, its key fetched again. */
    again: (id: string, connection: string) => `/devices/${at(id)}/ways/${at(connection)}/again`,
  },

  services: {
    add: (category?: string) => (category ? `/services/add/${at(category)}` : '/services/add'),
  },

  /** How a type is reached: its ways, to choose one — or straight on, with one named. */
  add: (typeId: string, from: SetupFrom = {}) => `/add/${at(typeId)}${query({ ...from })}`,

  /** A setup in progress, at one of its steps: `name` after the check, for a device added. */
  setup: (draft: string, step: string, from: Pick<SetupFrom, 'attach' | 'address' | 'through' | 'held' | 'then'> = {}) => `/setup/${at(draft)}/${at(step)}${query({ ...from })}`,

  automations: {
    list: '/automations',
    new: (device?: string) => `/automations/new${query({ device })}`,
    one: (id: string) => `/automations/${at(id)}`,
    /** Its editor: the view a query, so switching between the form and its YAML keeps what is being changed. */
    edit: (id: string, view: 'form' | 'yaml' = 'form') => `/automations/${at(id)}/edit${query({ view: view === 'yaml' ? 'yaml' : undefined })}`,
    configuration: (id: string) => `/automations/${at(id)}/configuration`,
    run: (id: string, run: string) => `/automations/${at(id)}/runs/${at(run)}`,
  },

  integrations: {
    list: '/integrations',
    one: (id: string) => `/integrations/${at(id)}`,
    account: (id: string, account: string) => `/integrations/${at(id)}/accounts/${at(account)}`,
    gateway: (id: string, gateway: string) => `/integrations/${at(id)}/gateways/${at(gateway)}`,
  },

  problems: '/problems',

  settings: {
    index: '/settings',
    accounts: '/settings/accounts',
    connectivity: '/settings/connectivity',
    configuration: (open: { import?: boolean; from?: string } = {}) => `/settings/configuration${query({ import: open.import ? '1' : undefined, from: open.from })}`,
    serverLog: '/settings/server-log',
    maps: '/settings/maps',
    homes: '/settings/homes',
    zones: '/settings/zones',
    labels: '/settings/labels',
    people: '/settings/people',
    join: '/settings/join',
    home: (id: string) => `/settings/homes/${at(id)}`,
    zone: (id: string) => `/settings/zones/${at(id)}`,
  },
} as const;

/**
 * A thing you have, by its kind: a device or a service to its own page, an
 * account or a gateway to its integration's — where each is met.
 */
export function pathOf(thing: { id: string; kind: DeviceKind; integration: { id: string } | null }): string {
  if (thing.integration && thing.kind === 'account') return PATHS.integrations.account(thing.integration.id, thing.id);
  if (thing.integration && thing.kind === 'gateway') return PATHS.integrations.gateway(thing.integration.id, thing.id);
  return PATHS.devices.one(thing.id);
}
