# @kraftverk/integration-niu — NIU's scooters

## What it is

NIU as a platform: the **NIU account** — the sign-in the NIU app uses, a
device of its own (`niu.account`) — and electric scooters read through it
from **NIU's cloud**: their charge, whether they are charging, range,
odometer and state. The first use: a smart plug in front of a scooter's
charger stops it at a limit, with the shared "Charge between two levels"
automation — this scooter's battery, that plug.

It holds what every NIU scooter shares: `defineNiuScooter`, which builds a
model's type from what the model says about itself; and the generic NIU
scooter (`niu.scooter`), the one a model nobody has described falls back
to. A model with a device package of its own is built on this (below).
Support is `experimental` until a model has been mapped.

## What it does — and does not

- **Does:** sign in to NIU's cloud once, as an account, and be the bridge
  to every scooter on it (docs/PLAN-INTEGRATIONS.md §4.3); read each scooter
  through it — charge, charging, range, odometer, state — as a vehicle; the
  builder a model is made with; the generic scooter and its screens, which
  models reuse; the integration's own panel on an account's page — how NIU
  is asked, and where the password is kept (`ui/integration.tsx`); and how a configuration file kept before the account was a
  device of its own comes back with one (`src/migrations.ts`).
- **Does not:** know a model — each is a device package that names this
  integration — control the scooter (it is read only), or charge it — a plug in front of its
  charger and an automation do.

## Where it fits

An integration (docs/PLAN-INTEGRATIONS.md §1.1), over the internet: the HTTPS
transport, NIU's hosts only. It imports the SDK, and speaks NIU's cloud itself; device
packages for NIU's models import it — for one, `@kraftverk/device-niu-uqi-gt`.

## Why a package of its own

Because what NIU's scooters report, and how, is NIU's platform: written once
here, and each model adds only what is its own.

## How it is reached

A NIU scooter of this age has **no way in but NIU's cloud**. Its control unit
reports over the mobile network to NIU; the NIU app reads it back from NIU,
and so do we. No Bluetooth: NIU's Bluetooth protocol
([niu-kqi](https://github.com/BaesTheorem/niu-kqi)) is for kick scooters and
newer mopeds with "NIU Link".

**The account** (`niu.account`):

- Protocol: `niu-cloud` (`src/protocol/`), over `https`: signing in,
  tokens, the scooters on an account and what each last reported. Pure, the
  SDK only.
- Two hosts, outside China: `app-api-fk.niu.com` (everything) and
  `account-fk.niu.com` (signing in). The channel reaches those two and nothing
  else (`OpenOptions.alsoOrigins`).
- Reach: `cloud` — always the internet.
- Credentials: the NIU app's account (email or phone) and password — once,
  however many scooters are on it. The password is the account connection's
  secret, encrypted where it is held, and sent only to NIU — hashed, as the
  app does. Tokens live in memory only.
- Two facts, kept apart (docs/PLAN-INTEGRATIONS.md §0): **where** it can be
  held — a server or a phone, never a browser, because NIU's cloud sends no
  CORS headers (`platforms`) — and **what** the node holding it must be:
  trusted with the password (`needs: { trusted }`).
- Its identity is its sign-in, written plainly: NIU names no account id.

**A scooter** (`niu.scooter`, and each model's type): reached **through its
account** (`through: ['niu.account']`), its address its serial. It keeps no
credentials and speaks no protocol: its session links to it through the
account (`ScooterLink`, `src/link.ts`) — plain calls, `report()`,
`slow()`, `raw()`, `ask()` — and the account calls it back when NIU has
said something new (docs/PLAN-INTEGRATIONS.md §1.1). Its identity is
`niu-cloud:<serial>`, as before. A device package for a model reads it
through the same link, imported from `@kraftverk/integration-niu`.

- Adding: add the account and sign in; its scooters are then found — on Home
  under "Found near you", and on the account's page — each offered as the
  model it says it is, or as the common scooter.

## What NIU's cloud says — as those before us found it

Nothing here is documented by NIU. It is what the app sends, read by others:

| Call | Method | Used for |
|---|---|---|
| `account-fk…/v3/api/oauth2/token` | POST form: `account`, `password` = MD5 hex, `grant_type=password`, `scope=base`, `app_id` | Signing in: `data.token.access_token`, `refresh_token`, `token_expires_in`, `refresh_token_expires_in` |
| same | POST form: `grant_type=refresh_token`, `refresh_token`, `app_id` | Renewing without the password |
| `/v5/scooter/list` | GET | The account's scooters: serial in `sn` — **or `sn_id` on some models, reported for a UQi GT** — `scooter_name`, `sku_name` |
| `/v5/scooter/motor_data/index_info?sn=` (older: `/v3/motor_data/index_info`) | GET | The state (below) |
| `/v3/motor_data/battery_info?sn=` | GET | Per battery: `batteryCharging`, `temperature`, `gradeBattery` (health), `chargedTimes` (cycles), `energyConsumedTody` |
| `/motoinfo/overallTally` | POST `{ sn }` | `totalMileage` (km), `bindDaysCount` |
| `/v5/track/list/v2` | POST `{ index, pagesize, sn }` | Trips: `startTime`, `endTime`, `distance` (m), `avespeed`, `ridingtime` (s), `power_consumption` (%) |
| `/v5/cmd/creat` | POST `type` = `acc_on`, `acc_off`, `fortification_on`, `fortification_off` | Commands, on newer models. **Not used.** |
| `/v5/scooter/car_machine/align` | GET/POST | Charging limit (`sup_charging_limit`, `charging_limit_value` 80–100 %) and charging power, on newer models. **Not used.** |

Every request but the sign-in carries the token in a header named `token` and
an app-like `user-agent`. Every answer is `{ status, desc, trace, data }`:
`status` 0 is success; **1131** is "signed out", after which we sign in again
and ask once more.

The `app_id` is not stable: projects use `niu_ktdrr960`, `niu_8xt1afu6`,
`niu_fksss2ws`, each from an app version. One constant: `NIU_APP_ID`.

### The state (`index_info`)

| Field | Here | Notes |
|---|---|---|
| `batteries.compartmentA.batteryCharging` (and B, C) | `soc` (the scooter's headline) | The mean of the batteries in; a UQi has one |
| `isCharging` | `charging` | 0/1. **Seen** turning 1 about a minute after the charger went in, in a report sent with the scooter switched off |
| `isConnected` | `online` | **Not a charger**, as evcc reads it: `true` on a UQi GT with no charger anywhere near it. It reaches NIU — as `ss_online_sta: "1"`. NIU gives no "charger plugged in" |
| `leftTime` | `minutesToFull` | Hours, and there when not charging too (`"0.2"` idle): read only while charging |
| `estimatedMileage` | `range` | km |
| `nowSpeed` | `speed` | km/h, at the report: no speed curve from reports minutes apart |
| `isAccOn` | `poweredOn` | **Seen**: 1 switched on, 0 within seconds of switching off |
| `isFortificationOn` | `alarmArmed` | `""` on a UQi GT, its alarm armed or not: that model does not say |
| `lockStatus` | `lockStatus` (raw) | 1 on a UQi GT switched on and off alike, seat locked: not the ignition. Meaning **to map** |
| `gsm`, `gps` | `mobileSignal`, `gpsSignal` | `gsm` 16–18 on a UQi GT (a 0–31 scale, as a modem's), `gps` 5 |
| `centreCtrlBattery` | `controlUnitBattery` | % |
| `infoTimestamp` / `time` / `gpsTimestamp` | every reading's time | **When the scooter reported**, not when we asked. Switched on, it reports all the time (a second old whenever asked); switched off, it goes quiet — see below |
| `postion` (sic), `hdop` | — | Left out: where the owner lives and rides |
| `lastTrack` | — | The trip in progress; later |

## How it behaves

- **Pulled**, never pushed: NIU's cloud has no way to tell anyone else. The
  scooter reports to NIU over the mobile network on its own rhythm; its
  account asks NIU — for each scooter someone has added — every minute while
  it is charging or switched on, every 10 min otherwise; battery health and
  the odometer every 30 min; and which scooters are on it every 30 min. One
  sign-in, one conversation with NIU, however many scooters.
- **Parked** (not charging, not switched on), the scooter goes quiet, and its
  charge does not move — so its last report stands for as long as NIU keeps
  answering, and a charge limit can act on it however long ago the scooter
  reported. Its readings keep the time the scooter reported them, and say
  when NIU last confirmed them (`Reading.confirmedAt`, from
  `confirmedSince`). **Charging or switched on**, a report older than 30 min
  is not known: nothing acts on it.
- The app says when it last reported ("Reported to NIU 3 minutes ago") from
  the session's `lastReadingAt`; the server says no clock time — its time
  zone need not be its owner's.
- Charging starting and stopping are events on the battery, with the charge.
- No commands yet.
- Tool **What NIU says** (`raw`): every field of the state (and which call
  answered, v5 or v3), the batteries and the totals — position removed. How
  the model is mapped.

## Models

This package is the **common** NIU scooter: how any scooter NIU's cloud
speaks for is reached and read. It claims no model, and has no picture of
its own — the NIU brand, on its icon.

A model gets **a device package of its own**, built on this integration with
`defineNiuScooter({ id, meta })`: its name, the model names NIU's account
gives it (the check step offers the model's type for a scooter reporting one
of them), its pictures, and — as it is mapped — what only that model does.
It inherits everything else, and keeps what is still in common.

- [`niu-uqi-gt`](../../devices/niu-uqi-gt/README.md) — the UQi GT and GT Sport, being
  mapped on a 2019 GT Sport.

## Charging it to a limit

The ATORCH feeds the charger; the scooter's charge comes from the cloud.
"Charge between two levels" with the scooter's battery and the plug, and
"Keep it so" on: the plug goes off at the upper level. A UQi's battery takes
about 250 W (48 V × 5.2 A), about 1 % in 3–4 minutes. The server asks NIU
every minute while it charges, but a UQi GT charging switched off reports to
NIU only every 4–5 minutes (the mapping log, `niu-uqi-gt`): expect it to
stop 1–2 % past the level.

## Its page

`ui/` — the dashboard, for every NIU model: its charge, large, on a bar;
what it is doing ("Charging", "Parked", "Switched on") and what follows
("Full in about 2 h 38 min", "About 48 km of range"); its range and
odometer; **when it last reported to NIU**, ticking — and, parked, that its
charge still holds, or, charging, that it may have moved on. Its battery's
health and temperature. What NIU says for working things out (signals, the
control unit, the raw lock status) folded away under "More from NIU". The
alarm only where the model says it. Words are in `ui/words.ts`, tested.

The scooter is not the target of a "feeds" link: kraftverk checks such a link
by the target seeing its mains within 30 s, and a scooter reporting through
the cloud cannot answer that fast.

## Those before us

- [bonnee/niu-charge](https://github.com/bonnee/niu-charge) — stops a Tuya plug
  at a limit; the owner's fork is where this started.
  [MyNIU forum](https://www.myniu.org/forums/topic/niu-automatic-charging-management/).
- [NeariX67/home-assistant-niu-component](https://github.com/NeariX67/home-assistant-niu-component)
  — the fullest: v5 calls, commands, charging settings.
- [TA2k/ioBroker.niu](https://github.com/TA2k/ioBroker.niu) — token refresh;
  the UQi GT `sn_id` report.
- [evcc vehicle/niu](https://pkg.go.dev/github.com/evcc-io/evcc/vehicle/niu) —
  charge and charging for an EV charger.
- [bonnee/niu-app-api](https://github.com/Bonnee/niu-app-api),
  [cascha42/niu-info](https://github.com/cascha42/niu-info),
  [bilbo-b/niu-api.py](https://github.com/bilbo-b/niu-api.py),
  [volkerschulz/NIU-API](https://github.com/volkerschulz/NIU-API),
  [node-red-contrib-niu-cloud](https://www.npmjs.com/package/node-red-contrib-niu-cloud).

<!-- quality: written by npm run check:integrations -->
## Quality, measured

7 of 7 (docs/PLAN-INTEGRATIONS.md §10):

- ✓ Every type keeps the device-type contract, its simulator included
- ✓ Every value a person reads has a meaning or a quantity
- ✓ Every key, password or token is a secret: sealed, and left out of what is shown
- ✓ Every way says how far it reaches and how what it says arrives
- ✓ A device that announces itself is found by what its protocol declares
- ✓ Its packages have tests of their own
- ✓ Its packages say what they are
<!-- /quality -->
