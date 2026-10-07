# @kraftverk/integration-elprisetjustnu — Sweden's electricity prices

## What it is

A service, not hardware: the day-ahead electricity price for a Swedish price
area, from [elprisetjustnu.se](https://www.elprisetjustnu.se/elpris-api) —
free, with no account and no key. Only the price area is sent, to ask for
its prices.

## What it does — and does not

- **Does:** speak the price API (`src/protocol/`): the request for a day's
  prices in a price area, and how to read the answer, over HTTPS. A price
  area as a service: the price now and the hour's rank among the day's,
  which automations can use.
- **Does not:** decide when to charge — automations do.

## Where it fits

An integration (docs/PLAN-INTEGRATIONS.md §1.1) whose one type is a service:
a device type of kind `service`, over the HTTPS transport. Prices are the
platform's, not a product, so no device package builds on it.

## Why a package of its own

Because a data source is a package like a device: a home that does not
want Swedish prices does not carry them.

## What it reports

One part, the price area, offering `energyPrice`:

| Attribute | Meaning | What it is |
|---|---|---|
| `price` | `price` | What electricity costs in the quarter hour now, per kWh, in SEK or EUR as chosen — the market price, without tax, fees or your supplier's margin. |
| `rank` | `priceRank` | Where the hour now stands among the day's hours by price: 1 is the cheapest. |

- **Periods are quarter hours** since Nord Pool moved to them in October
  2025. A **rank is of hours**, each at the average of its four quarters,
  so "the four cheapest hours" means what it says.
- **A day is the Swedish calendar day**: 23 hours in March, 25 in October,
  and ranked among those.
- **A day known only in part ranks nothing**: the rank is unknown rather
  than "cheapest" among the hours that happen to be known.
- A reading's time is when its quarter hour began, and it stays current for
  20 minutes: prices are published facts, not measurements.

## How it asks

- `GET /api/v1/prices/YYYY/MM-DD_SEn.json`, today's and tomorrow's, every
  30 minutes. Tomorrow's is published after about 13:00; asked for before,
  it answers 404, which is "not yet", not an error.
- What was fetched is kept (the device's store), so a restart has today's
  prices at once; a failed fetch leaves them in use as long as they cover
  now.

## In automations

The shared recipe **"In the cheapest hours"** (`standard.cheap-hours`)
switches something on in the day's cheapest hours and off in the others:
any part offering `energyPrice` fills its role, so another price service
would too. A rule of your own can use `priceRank` and `price` like any
reading — "only if the price is below 0.50".

## Simulated

A made-up day, cheap at night and dear in the morning and early evening,
per quarter hour, with no network.

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
