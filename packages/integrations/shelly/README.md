# @kraftverk/integration-shelly

## What it is

Shelly as a platform: Shelly's switches, plugs and relays of the second
generation and later (Plus, Pro, Gen3, Gen4), reached on the home network
with no cloud. Ported from Home Assistant's `shelly` integration and the
`aioshelly` library it uses — the first port by
[docs/PORTING-FROM-HOME-ASSISTANT.md](../../../docs/PORTING-FROM-HOME-ASSISTANT.md).

## What it does — and does not

- **Does:** speak Shelly's RPC — JSON over a WebSocket at `/rpc` on port 80
  (`src/protocol/websocket.ts`, `rpc.ts`) — and take what the device tells
  of every change as it happens (NotifyStatus, NotifyFullStatus), asking
  for everything once a minute besides; sign in with the SHA-256 digest a
  Shelly with a password asks for, and say so when the password is missing
  or wrong (the device then waits on you, on Home); find a Shelly by the
  `_shelly._tcp` service it announces over mDNS, with its MAC as its
  identity; and offer `shelly.switch`, which describes itself from what the
  device reports: each `switch:<n>` component an outlet that switches, with
  power, voltage, current, frequency, its energy count (kWh) and its own
  temperature where it measures them, and the Wi-Fi signal.
- **Does not:** reach a Shelly of the first generation (another API,
  CoIoT); covers, lights, dimmers, inputs, buttons, sensors and the Pro's
  energy meters; Bluetooth provisioning; anything through Shelly's cloud.
  Each comes when someone has the device to check it against.

## Where it fits

An integration (docs/PLAN-INTEGRATIONS.md §1.1): the one place kraftverk
meets Shelly. Its protocol in `src/protocol/` imports the SDK alone and is
pure — the home network's transport gives it a TCP connection, and it
speaks HTTP's upgrade and WebSocket frames itself — so it runs in the app as
well as on a server. A product's own package (a Plus Plug S with its
picture, say) builds on it.

## Why a package of its own

Because what every Shelly shares — how it is spoken to, found and signed
into, and what a switch component is — is written once, and a product is
then a small package of its own.

## Ported from

| Home Assistant | Here |
|---|---|
| `manifest.json`: zeroconf `_shelly._tcp`, `iot_class: local_push` | the `lan` way: `discovery` `_shelly._tcp`, `reach: local`, `updates: push` |
| `config_flow.py`: host, then username and password when `auth_en` | the address, found or typed; the protocol's `password` credential, asked as a secret |
| `unique_id`: the MAC | the identity `shelly-rpc:<mac>`, read at the check |
| `ConfigEntryAuthFailed` | `NeedsSignIn`: the device waits on a person |
| the RPC coordinator: WebSocket, NotifyStatus merged into the status | the session: notifications merged (`merged`), the status asked once a minute |
| `switch` platform: `Switch.Set` | the `switch` capability, `set`, on the output's part |
| `sensor` platform: `apower`, `voltage`, `current`, `freq`, `aenergy.total`, `temperature.tC`, Wi-Fi RSSI | attributes with standard meanings — power, voltage, current, frequency, energy (kWh, total increasing) — the switch's temperature and the signal as diagnostics |

## Verified

Nothing yet on a real Shelly: the protocol is tested against a device played
in the tests (`test/`), byte for byte at the WebSocket. Its support level
says so (`experimental`) until it has been.

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
