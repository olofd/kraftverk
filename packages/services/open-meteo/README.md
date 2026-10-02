# @kraftverk/service-open-meteo — the weather

## What it is

Weather from Open-Meteo, as a service: the forecast for a place, with no
account and no key.

## What it does — and does not

- **Does:** a place's forecast, answered as the `weather.forecast`
  capability's queries; and what it brings to automations
  (`kraftverk.automation`): a function that says whether a day looks sunny,
  and the recipe built on it.
- **Does not:** speak the API (`@kraftverk/protocol-open-meteo`), or switch
  anything — automations do.

## Where it fits

A service: a device type of kind `service`, over the HTTPS transport,
with an automation contribution beside its type.

## Why a package of its own

Because weather is one source among others: a home installs it, and a
recipe written against the forecast capability works with whichever
forecast it has.
