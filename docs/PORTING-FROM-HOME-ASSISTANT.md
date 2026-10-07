# Porting an integration from Home Assistant

How an integration in `home-assistant/core/homeassistant/components/<domain>/`
becomes a kraftverk integration in TypeScript, in one sitting. A current
document: it says what kraftverk has today, and plainly where something is
not built yet. The design behind it is [PLAN-INTEGRATIONS.md](PLAN-INTEGRATIONS.md)
§1.1 and §8; the package rules are [ADDING-A-DEVICE.md](ADDING-A-DEVICE.md).

It is a port, not a wrapper. Home Assistant's code shows what the device or
service says and how to ask it; kraftverk's model decides what it becomes.
Never copy its entities one for one: a device is parts with meanings and
capabilities, and what a person sees is said in kraftverk's words, not the
vendor's or Home Assistant's.

## The shape it becomes

| | |
|---|---|
| **Integration** — `packages/integrations/<id>/` | The one place kraftverk meets the service: its protocol in `src/protocol/` (pure, the SDK only), its ways in and their setup, its accounts and gateways, its own screens, the builder its products are made with, and a generic type for a device nobody described. Names no product. |
| **Device package** — `packages/devices/<product>/` | One product on it, mostly data on the integration's builder: its model names, its pictures, what only it reports. Imports its integration and nothing else. |

Make them with `npm run new:integration -- <id>` and `npm run new:device --
<product> <id>`: both pass every check as made.

## The map

| Home Assistant | Kraftverk |
|---|---|
| `components/<domain>/` | `packages/integrations/<id>/`, and a device package per product it knows by name |
| `manifest.json` | `package.json` → `kraftverk.integration`: its id, name, types, protocols, screens, migrations |
| a table of models or product keys inside the integration | device packages, each claiming its models (`meta.models`) |
| `integration_type: device` | a type of kind `hardware` |
| `integration_type: hub` | an `account` or `hardware` type with `bridge`, and its members' types with a way `through` it ([ADDING-A-DEVICE.md](ADDING-A-DEVICE.md#an-account-and-a-device-behind-it)) |
| `integration_type: service` | a type of kind `service` |
| `iot_class` | each way's `reach` (`local`, `cloud-at-setup`, `cloud`) and `updates` (`push`, `poll`, `both`) |
| `requirements` (a PyPI library) | the integration's protocol, ported from the library: pure, over the channel its transport gives. A maintained MIT TypeScript library may be vendored behind it instead |
| `zeroconf`, `ssdp`, `bluetooth`, `mqtt` discovery keys | a way's `discovery` matchers (`mdns`, `ssdp`, `advert`, `client`, `broadcast`), and its protocol's `recognise` to confirm and read what they picked out |
| `dhcp` discovery | not yet: the relay will hear it (PLAN-INTEGRATIONS.md §4.4) |
| `config_flow.py` `async_step_user` | the setup plan: the protocol's `credentials` (a schema, and actions), the way's and the type's own `steps` |
| a two-factor code, a PIN the TV shows | an action that answers `ask` — the app draws the form inside the step and runs the action again; `carry` keeps what the next turn needs, never shown |
| waiting on the person (scan a QR code, press a button) | an action that answers `waiting`, asked again until it is done |
| OAuth / `application_credentials` | not yet |
| `async_step_reauth`, `async_step_reconfigure` | setting a way up again (`setup.again`): the same credentials and steps, then a check that it is the same device |
| an options flow | the device's settings (`config`), and the way's own (`config` on the method) |
| `unique_id` | the identity `identify` returns at the check, namespaced by the protocol (`identityOf`) |
| `ConfigEntry.data` | the connection's config, and its secrets (fields with `presentation: 'secret'`) |
| a token the library refreshes and stores | a secret field with `kept: 'session'`, written by the session (`connection.secrets.set`) |
| `async_setup_entry` | `createSession` |
| `runtime_data` | the session object |
| `ConfigEntryNotReady` | throw `NotReachable` (with `retryAfterMs` when the service says when) |
| `ConfigEntryAuthFailed` | throw `NeedsSignIn`: the device waits on a person, on Home, never retried in a loop |
| `DataUpdateCoordinator` | the session's `ctx.schedule(everyMs, task)`; for a hub, its bridge fetches once for all its members |
| `DeviceInfo` (manufacturer, model, versions) | the session's `info()` |
| `via_device` | a connection `through` a bridge |
| several entities of one physical thing | parts of one device |
| a `SensorEntityDescription` list | attributes in the description: key, label, value type and unit, `means` (a standard meaning), state class |
| `device_class` with its native unit | a standard meaning and a unit (`units.ts`); a quantity (`quantities.ts`) when no meaning fits |
| `entity_category: diagnostic` / `config` | an attribute's `category`: `diagnostic`; a setting (`access: 'write'`, `category: 'config'`) |
| `switch` | the `switch` capability |
| `sensor` | attributes; a library capability where one fits (`powerMeter`, `battery`, `energyPrice`) |
| `device_tracker` | the `location` capability: a `position` attribute; `distance()` in automations |
| `light`, `media_player`, `climate`, `cover`, `lock`, `vacuum` | not yet: their capabilities come with the first integration that needs them (media with Apple TV, PLAN-INTEGRATIONS.md step 20) |
| `button` | a command with no arguments |
| `number`, `select`, `text` used as settings | settings, written through the gateway |
| `event` entities, events on the bus | declared events (`description.events`), raised with `ctx.event` |
| actions in `services.yaml` | capability commands; one with an answer is a query; one only this device has is a tool |
| `diagnostics.py` | the device's tools and the server's diagnostics; secrets are redacted by being secret fields |
| `strings.json` | the words in the type; translations later |
| `quality_scale.yaml` | measured: `npm run check:integrations` writes it into the README |
| tests with `MockConfigEntry` and mocked clients | the type's simulator, the contract suite (`checkDeviceTypeContract`), and fixtures recorded from the device or taken from the library's own tests |

## The recipe

1. **Read** the manifest, `config_flow.py`, the coordinator, every platform
   file and `services.yaml`, and the library's client. Write down what is
   signed into, what is found and how, what is fetched how often, every
   value and its unit, every command and what it changes physically.
2. **Scaffold:** `npm run new:integration -- <id>`, then one
   `npm run new:device -- <product> <id>` per product it knows by name.
3. **Protocol** (`src/protocol/`): port the library's calls over the channel
   the transport gives — `https` for a cloud (an origin per way), `lan` for a
   device on the home network, `ble`, `mqtt`. No I/O of its own: secrets in,
   typed values out. Declare it in the manifest's `protocols`; its id is the
   integration's, or begins with it. Its `credentials` are what setup asks
   for; its binding's `recognise` reads what discovery picked out.
4. **Ways in:** each a protocol over a transport, with `reach`, `updates`,
   what it `needs` of the node holding it (a vendor password needs a node
   `trusted` with it), and its `discovery` matchers when the device announces
   itself.
5. **Types:** the integration's own — an account or gateway as a bridge, a
   service, the generic type — and each product on the builder. Values become
   attributes with standard meanings; controls become capabilities; anything
   that changes something physical declares its consequence; actions become
   commands, queries or tools.
6. **Setup:** the flow's steps become the plan; a code or a PIN becomes `ask`;
   the `unique_id` becomes the identity read at the check, so the same device
   is known however it was found.
7. **Simulator:** one that behaves like the device, so the contract suite,
   the app and a person without the hardware can use it.
8. **README** with the four headings ([ADDING-A-DEVICE.md](ADDING-A-DEVICE.md)),
   the devices it covers, what it does not support, and what was verified on
   real hardware. **NOTICE** with where it was ported from and the licences.
9. **Generate and check:** `npm run gen:devices` (the package's
   `catalogue.json` and the app's registry), `npm run check:integrations`,
   then `npm run typecheck`, `npm test` and `npm run check:architecture`.
   Commit what the generators wrote.

## Licences

Home Assistant's core is Apache-2.0. Translating an integration's code is a
derivative work: keep the licence, say in the ported files that they were
changed, and keep the attribution — in the package's `NOTICE`. Its libraries
vary: many are MIT (keep the copyright notice), some are GPL and must be
checked before anything is ported from them. Using a vendor's private web API
is a question of its terms, not of copyright: the README says so where it
applies.

## What is not built yet

- **OAuth** sign-in, and DHCP discovery.
- **The capabilities** for lights, media players, climate, covers, locks and
  vacuums: each comes with the first integration that needs it, borrowing
  Matter's cluster where there is one.
- **A diagnostics bundle** like Home Assistant's `diagnostics.py`: today a
  device's tools and the server's diagnostics stand in for it.
- **Translations.**

When a port needs one of these, it is built in the SDK first, as its own
change, and this document says so.
