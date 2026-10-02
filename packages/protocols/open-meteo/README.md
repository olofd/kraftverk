# @kraftverk/protocol-open-meteo — the Open-Meteo API

## What it is

The Open-Meteo forecast API: the request for a place, and how to read the
answer.

## What it does — and does not

- **Does:** build the request and read the answer, over an HTTPS channel.
- **Does not:** keep a place, or say what a forecast means for a home: the
  weather service does.

## Where it fits

A protocol: pure, importing only the SDK; the weather service uses it.

## Why a package of its own

Because a service's wire format is its own, tested apart from what is
done with it.
