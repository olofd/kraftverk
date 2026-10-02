# @kraftverk/device-tuya-plug — the Tuya energy socket

## What it is

Tuya energy sockets as smart plugs: a relay and a meter, reached on the
home network with the Tuya local protocol and no cloud — the generic socket,
and `defineTuyaSocket`, which builds a socket type from a data layout.

## What it does — and does not

- **Does:** the socket's session — polling, pushes, the relay, settings
  by profile, live readings, a meter refreshed through a Zigbee gateway, its
  readings dated by when they were measured — and its simulator.
- **Does not:** speak Tuya (`@kraftverk/protocol-tuya-local`), or know a
  model's layout: each model is a family package built on this.

## Where it fits

A device type, and the base of families (`atorch-s1w`,
`tuya-zigbee-plug`), which build on it by its name.

## Why a package of its own

Because every Tuya socket is the same device apart from its data layout:
written once here, the next plug is a profile.
