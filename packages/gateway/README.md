# @kraftverk/gateway — every physical action, one path

## What it is

The action gateway: the only way a command or a setting reaches hardware.
Whoever asks — a person on a screen, an automation, the assistant — asks
it, and it decides, sends, and checks what the device then says.

## What it does — and does not

- **Does:** checks a command against what the part offers and the
  arguments against their schema; refuses what read-only forbids; asks a
  person to confirm what is consequential (switching off a load, a station
  feeding another device), never letting an automation confirm for itself;
  keeps a dwell between switches; sends, then verifies against what the
  device reports — and against the station a plug feeds; writes every act to
  the timeline. Its memory of the last switch and write is a port it
  declares (`GatewayLedger`), the store's to keep.
- **Does not:** open a device (the holder does), know any product, or keep
  anything itself. It never guesses: a command it cannot verify says so.

## Where it fits

A rule of the layers just above the contract (docs/PLAN-SHARED-CORE.md):
it imports only `@kraftverk/device-sdk`. The server and the app each run it
over the devices they hold; the engine and the hub hand it every action.

## Why a package of its own

Because "every physical action goes through the gateway" (AGENTS.md) is
only true if there is one gateway, and it runs wherever a device's
connection is held — the server, a browser, a phone. Pure and alone, it is
the same rules everywhere, and a mistake in safety is fixed once.
