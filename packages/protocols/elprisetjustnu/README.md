# @kraftverk/protocol-elprisetjustnu — the price API

## What it is

The elprisetjustnu.se price API: the request for a day's electricity prices
in a Swedish price area, and how to read the answer.

## What it does — and does not

- **Does:** build the request and read the answer, over an HTTPS channel.
- **Does not:** rank prices or say what they mean for a home: the price
  service does.

## Where it fits

A protocol: pure, importing only the SDK; the price service uses it.

## Why a package of its own

Because a service's wire format is its own, tested apart from what is
done with it.
