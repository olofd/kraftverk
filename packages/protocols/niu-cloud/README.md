# @kraftverk/protocol-niu-cloud — the NIU cloud

## What it is

The NIU cloud as the NIU app speaks it: signing in, tokens, the scooters
on an account, and what each last reported.

## What it does — and does not

- **Does:** the requests and how to read their answers, and a binding
  for the HTTPS transport reaching NIU's two hosts.
- **Does not:** know a model, keep anything, or reach any other host.

## Where it fits

A protocol: pure, importing only the SDK; the NIU scooter is built on it.

## Why a package of its own

Because NIU's API is NIU's, not the core's, and every NIU model reads
through the same calls.
