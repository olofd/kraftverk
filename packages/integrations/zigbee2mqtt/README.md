# @kraftverk/integration-zigbee2mqtt

## What it is

Zigbee, through [Zigbee2MQTT](https://www.zigbee2mqtt.io) running beside
kraftverk: a Zigbee USB dongle on the server's host (a Sonoff ZBDongle-P,
Z-Stack), driven by Zigbee2MQTT in its own container, which speaks to
kraftverk's own MQTT broker. The plan it follows, and why Zigbee2MQTT rather
than a radio stack inside kraftverk: [docs/PLAN-ZIGBEE.md](../../../docs/PLAN-ZIGBEE.md).

## What it does — and does not

- **Does:**
  - speak Zigbee2MQTT's MQTT API (`src/protocol/`): the bridge's state, info, devices and groups (retained), each device's state and availability, `/set` and `/get` addressed by IEEE address, and bridge requests matched to their answers by `transaction`;
  - offer the coordinator, `zigbee2mqtt.bridge`, as a gateway — found when Zigbee2MQTT connects to the broker — with its devices and groups as its members, letting devices join for up to 254 s (`Bridge.join`), and its tools: a network backup, removing a device, and making and changing groups;
  - describe every device from what it exposes (`exposes.ts`): a part per switch, light, fan, cover, lock or thermostat (per endpoint), each feature an attribute — power, voltage, current, energy and temperature with their standard meanings when in the meaning's own unit, humidity and illuminance as their quantities, binaries read by their own `value_on` (a contact's on is open), a battery's voltage kept apart from the mains', a light's brightness as a percentage, colours as objects, settable features as settings — and button presses as events (`action.single`, …);
  - offer each device as the generic type of its shelf — `zigbee2mqtt.plug`, `.switch`, `.light`, `.sensor`, `.climate`, `.lock`, `.cover` — and each group as `zigbee2mqtt.group` or `.light-group`, which do what any member can, switched as one Zigbee command;
  - switch a part with `switch.set` and write settings through the gateway, read back from what Zigbee2MQTT says after;
  - update a device's firmware (`src/updates.ts`, docs/PLAN-ZIGBEE.md §5.7): what it runs, the newer one Zigbee2MQTT's index offers and what it changes as readings; *Update*, *Stop* and *Check* as the device's tools, a person's alone — one device at a time, the rest waiting their turn, a device on batteries scheduled for when it wakes — followed by its state, not by Zigbee2MQTT's hours-late answer, its settings compared after, and each outcome an event (`firmware.updated`, `firmware.failed`, `firmware.settings-changed`);
  - give the broker its policy: every topic under `zigbee2mqtt/` is the coordinator's, spoken for only by a client signed in to the broker; only the server commands; the bridge requests that change the network itself (its settings — the network key — a restart, touchlink, install codes, extensions) are refused to everyone, the server too, and so is a firmware update that names a source of its own (a `url`, an image as `hex`) or a downgrade; and it says the broker is busy while a device's firmware is being written, so a deploy leaves the broker and Zigbee2MQTT running;
  - play a Zigbee2MQTT in memory (`src/played.ts`) — the simulator, and what the tests run against.
- **Does not, yet:** downgrades, structured settings (a plug's overload protection), a device's own options, reconfigure, binding, reporting, scenes, the network map (docs/PLAN-ZIGBEE.md §5.5 says when each comes); speak MQTT from the app without a server (§9); run Zigbee without Zigbee2MQTT.

## Where it fits

An integration (docs/PLAN-INTEGRATIONS.md §1.1) on the `mqtt` transport:
its protocol in `src/protocol/` is pure — messages in, messages out — and
the coordinator's session speaks it over the channel the broker's transport
opens. The devices behind the coordinator are members of a bridge
(`ZigbeeLink`): read through it, never over MQTT of their own. A Zigbee
device's identity is `zigbee:<IEEE address>` — the same the Tuya gateway
gives its members — so a device moved from another coordinator keeps its
history (docs/PLAN-ZIGBEE.md §2.1). Zigbee2MQTT itself runs in its own
container (`docker-compose.yml`, the `zigbee` profile; docs/DOCKER.md).

## Why a package of its own

Because Zigbee is one platform with thousands of products: how Zigbee2MQTT is
spoken to, what its exposes mean and what its groups are is written once here,
and a product is then at most a small package of its own on top of it — most
need none, as each describes itself.

<!-- quality: written by npm run check:integrations -->
## Quality, measured

7 of 7 (docs/PLAN-INTEGRATIONS.md §10):

- ✓ Every type keeps the device-type contract, its simulator included
- ✓ Every value a person reads has a meaning or a quantity
- ✓ Every key, password or token is a secret: sealed, and left out of what is shown
- ✓ Every way says how far it reaches and how what it says arrives
- ✓ A device that announces itself says what it is found by
- ✓ Its packages have tests of their own
- ✓ Its packages say what they are
<!-- /quality -->
