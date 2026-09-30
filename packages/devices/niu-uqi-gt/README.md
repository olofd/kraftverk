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
   `sn_id`? What model name — is it one of `meta.models`?
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

What differs from the common scooter goes here, in this model's own type;
what turns out to be every NIU's goes to the common one. Then:
`support: 'verified'`.
