# NIU scooter

A NIU electric scooter, read from **NIU's cloud** with the owner's NIU account:
its charge, whether it is charging, its range, odometer and state. The first
use: a smart plug in front of its charger stops it at a limit, with the shared
"Charge between two levels" automation — this scooter's battery, that plug.

Being mapped on a **2019 NIU UQi GT Sport** (48 V, one removable battery,
1.5–2 kWh). Support is `experimental` until it has been.

## How it is reached

A NIU scooter of this age has **no way in but NIU's cloud**. Its control unit
reports over the mobile network to NIU; the NIU app reads it back from NIU,
and so do we. No Bluetooth: NIU's Bluetooth protocol
([niu-kqi](https://github.com/BaesTheorem/niu-kqi)) is for kick scooters and
newer mopeds with "NIU Link".

- Protocol: `niu-cloud` (`packages/protocols/niu-cloud`), over `https`.
- Two hosts, outside China: `app-api-fk.niu.com` (everything) and
  `account-fk.niu.com` (signing in). The channel reaches those two and nothing
  else (`OpenOptions.alsoOrigins`).
- Reach: `cloud` — always the internet.
- Credentials: the NIU app's account (email or phone) and password. The
  password is the connection's secret, encrypted on the server, and sent only
  to NIU — hashed, as the app does. Tokens live in memory only.
- Held only by the server (`serverOnly`): the password stays there, and NIU's
  cloud sends no CORS headers, so a web page could not reach it anyway.
- Adding it: sign in, and pick the scooter from the account's list.

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
| `isCharging` | `charging` | 0/1 |
| `isConnected` | `chargerConnected` | evcc reads it as "charger plugged in" — **to verify** |
| `leftTime` | `minutesToFull` | Hours; a large number when there is none |
| `estimatedMileage` | `range` | km |
| `nowSpeed` | `speed` | km/h |
| `isAccOn` | `poweredOn` | |
| `isFortificationOn` | `alarmArmed` | |
| `lockStatus` | `lockStatus` (raw) | Meaning per value **to map** |
| `gsm`, `gps` | `mobileSignal`, `gpsSignal` | NIU's bars |
| `centreCtrlBattery` | `controlUnitBattery` | % |
| `infoTimestamp` / `time` / `gpsTimestamp` | every reading's time | **When the scooter reported**, not when we asked |
| `postion` (sic), `hdop` | — | Left out: where the owner lives and rides |
| `lastTrack` | — | The trip in progress; later |

## How it behaves

- Read every minute while charging or with a charger in, every 10 min
  otherwise; battery health and the odometer every 30 min.
- A report stays current for 30 min. A scooter asleep reports seldom, and a
  charge older than that is not known — nothing acts on it.
- Charging starting and stopping are events on the battery, with the charge.
- No commands yet.
- Tool **What NIU says** (`raw`): every field of the state (and which call
  answered, v5 or v3), the batteries and the totals — position removed. How
  the model is mapped.

## Mapping the UQi GT Sport — what only the real scooter can answer

As with the ATORCH: one thing at a time, read, write down what moved.

1. Sign in (the owner, in the app's Add flow). Does the list give `sn` or
   `sn_id`? What model name?
2. Which state call answers: v5, or only v3?
3. `infoTimestamp`: how old while it sleeps, while it charges? That sets how
   often to ask and how long a report is current.
4. Charger plugged in with the plug off, then on: do `isConnected` and
   `isCharging` follow, and how soon?
5. `lockStatus`, `isAccOn`, `isFortificationOn`: lock it, unlock it, switch
   it on, arm the alarm — which values?
6. Battery info, totals, trips: which answer, and how their fields look.
7. The charging-limit and command calls: whether this model has them at all
   (expected: no). Asked only after we agree to.

Then: `support: 'verified'`, and what the values mean.

## Charging it to a limit

The ATORCH feeds the charger; the scooter's charge comes from the cloud.
"Charge between two levels" with the scooter's battery and the plug, and
"Keep it so" on: the plug goes off at the upper level. A UQi's battery takes
about 250 W (48 V × 5.2 A), about 1 % in 3–4 minutes, so a minute between
reads overshoots by under 1 %.

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
