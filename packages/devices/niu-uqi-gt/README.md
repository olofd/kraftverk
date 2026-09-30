# NIU UQi GT

The NIU UQi GT — sold as the **UQi GT Sport** in some markets — as a model of
its own. Built on the common [NIU scooter](../niu-scooter/README.md), which
says how it is reached (NIU's cloud, with the owner's NIU account) and what
it reports. This package adds its name, the model names NIU's account gives
it, and its pictures; what only this model does is added here as it is
mapped.

Being mapped on a **2019 UQi GT Sport**: 48 V, one removable battery
(31 Ah, about 1.5 kWh; 42 Ah on the extended range), about 250 W from its
charger (5.2 A), 45 km/h. No Bluetooth: NIU's cloud is the only way in.

## Pictures

`assets/image-1.png` … `image-3.png`, transparent, at most 1024 px: the first
is shown unless its owner picks another on the scooter's settings.

## Mapping — what only the real scooter can answer

As with the ATORCH: one thing at a time, read the tool **What NIU says**,
write down what moved.

1. Sign in (the owner, in the app's Add flow). Does the list give `sn` or
   `sn_id`? What model name — is it one of `meta.models`? *Answered:* the
   owner's account names it **`UQi-GT Citi Black (Matte)`** — a model name,
   then its finish. `UQi-GT Citi` is in `meta.models`; the check step takes a
   name with a finish after it as that model.
2. Which state call answers: v5, or only v3? *Answered:* **v5**.
3. `infoTimestamp`: how old while it sleeps, while it charges? That sets how
   often to ask and how long a report is current. *Partly answered:* switched
   on, it reports continuously (a second old whenever asked); switched off,
   it goes quiet (3 min and more without a report); charging while switched
   off, it reports **every 4½–5 minutes**. Parked for hours: **still to
   measure**.
4. Charger plugged in with the plug off, then on: do `isConnected` and
   `isCharging` follow, and how soon? *Answered:* `isConnected` is not the
   charger (true with none); `isCharging` turned 1 about a minute after the
   charger went in. With the plug off, then on: **still to try**.
5. `lockStatus`, `isAccOn`, `isFortificationOn`: lock it, unlock it, switch
   it on, arm the alarm — which values? *Partly:* `isAccOn` 1 on, 0 off;
   `isFortificationOn` is `""` armed or not — this model does not say;
   `lockStatus` 1 on and off, seat locked. The seat open, the alarm: **still
   to try**.
6. Battery info, totals, trips: which answer, and how their fields look.
   *Answered for battery and totals:* battery info has `gradeBattery`
   (health, `"86"`), `chargedTimes` (`"140"`), `temperature` (°C, with
   `temperatureDesc: "normal"`), `energyConsumedTody` (sic), and a
   476-point chart (`items`, all zeros) that means nothing to us. Totals:
   `totalMileage` (km, three decimals), `bindDaysCount`. Trips: not tried.
7. The charging-limit and command calls: whether this model has them at all
   (expected: no). Asked only after we agree to.

## Mapping log

What was done to the owner's scooter, and what NIU said — the evidence for
the answers above. No serials, no places.

**2026-09-30**, battery in, seat locked, 88 %, 12–13 °C:

| Done | NIU said | So |
|---|---|---|
| Nothing: switched on, no charger | `isAccOn` 1, `isConnected` true, `ss_online_sta` "1", `lockStatus` 1, `isCharging` 0, `leftTime` "0.2", `infoTimestamp` a second old — on every ask, 20 s apart | Switched on, it reports all the time. `isConnected` is not a charger. `leftTime` is there when not charging |
| Switched off, locked | Within 2 min: `isAccOn` 0; `infoTimestamp` stopped — 128 s, then 180 s old; still `ss_online_sta` "1" | Off, it goes quiet but stays reachable |
| Switched on (the alarm sounds if a charger goes in with it off), charger in, charging, switched off | 31 s after: `isAccOn` 0, `isCharging` still 0. A minute later a new report, sent switched off: `isCharging` 1, `leftTime` "0.2" | It notices charging within about a minute, and reports it while off. The NIU app agreed |
| Left charging, switched off | Reports at about 16:40:56, 16:45:15, 16:50:15 — every 4½–5 min. Still 88 %, `leftTime` still "0.2", 10 min into charging | Charging switched off, **a report every ~5 min**: a charge limit stops 1–2 % late. Whether 88 % stood still or NIU's % lags: **to see** |

The alarm: armed when switched off (a charger going in sets it off), yet
`isFortificationOn` stays `""` — so `alarmArmed` is never known on this
model.

What differs from the common scooter goes here, in this model's own type;
what turns out to be every NIU's goes to the common one. Then:
`support: 'verified'`.
