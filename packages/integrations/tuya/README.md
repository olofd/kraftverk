# @kraftverk/integration-tuya — Tuya's energy sockets

## What it is

Tuya as a platform: energy sockets as smart plugs — a relay and a meter —
reached on the home network with the Tuya local protocol and no cloud. It
holds what every Tuya socket shares: `defineTuyaSocket`, which builds a
socket type from a data layout, and the generic Tuya plug (`tuya.plug`), the
one a socket nobody has described falls back to.

## What it does — and does not

- **Does:** the socket's session — polling, pushes, the relay, settings
  by profile, live readings, a meter refreshed through a Zigbee gateway, its
  readings dated by when they were measured — and its simulator; the generic
  plug, with one profile per socket layout it knows.
- **Does not:** speak Tuya (`@kraftverk/protocol-tuya-local`), or know a
  product's layout: each product is a device package built on this.

## Where it fits

An integration (docs/PLAN-INTEGRATIONS.md §1): it imports the SDK and the
Tuya local protocol; device packages for Tuya-based products import it —
`@kraftverk/device-atorch-s1w` and `@kraftverk/device-tuya-zigbee-plug`
among them.

## Why a package of its own

Because every Tuya socket is the same device apart from its data layout:
written once here, the next plug is a profile in a package of its own.
