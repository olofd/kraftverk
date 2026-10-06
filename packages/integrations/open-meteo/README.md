# @kraftverk/integration-open-meteo — the weather

## What it is

Open-Meteo as a platform: its forecast API, and the weather forecast for a
place as a service (`open-meteo.weather`), with no account and no key.

## What it does — and does not

- **Does:** speak the API (`src/protocol/`): the request for a place, and
  how to read the answer, over an HTTPS channel. A place's forecast,
  answered as the `weather.forecast` capability's queries; and what it
  brings to automations: a function that says whether a day looks sunny,
  and the recipe built on it.
- **Does not:** switch anything — automations do.

## Where it fits

An integration (docs/PLAN-INTEGRATIONS.md §1.1) whose one type is a service:
a device type of kind `service`, over the HTTPS transport, with what it
brings to automations beside it. A forecast is the platform's, not a
product, so no device package builds on it.

## Why a package of its own

Because weather is one source among others: a home installs it, and a
recipe written against the forecast capability works with whichever
forecast it has.
