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
