# @kraftverk/map

## What it is

Where things are, drawn — as data. The style a map is drawn in, over the
home's own Protomaps tiles; what a map shows (markers, how sure each is,
trails, zones) as GeoJSON; the countries, and the areas around a place, a
home may hold the map of; and the arithmetic of tiles and boxes. The plan:
[docs/PLAN-MAPS.md](../../docs/PLAN-MAPS.md).

## What it does — and does not

- **Does:** build the style both renderers draw — MapLibre on the web and on
  a phone — with every URL the home's own (`/api/map/tiles`, `/fonts`,
  `/sprites`), credited to OpenStreetMap; turn markers, accuracies, trails and
  zones — and a home's drawn rooms — into GeoJSON; turn a point in a home's
  frames (`frames.ts`: metres in a space's frame, up the tree of spaces to
  the site, onto the Earth by the home's place and bearing) into latitude
  and longitude and back, place a floor's drawing by its corners, and find
  the innermost drawn room a point is in; find the box around what is shown, the tile a place is
  in and what a tile covers; know every country by its code, name and box
  (`countries.ts`, generated from Natural Earth by
  `scripts/gen-countries.mjs`), the country a place is in, and the box of
  the area around a place; and say how far a home's geometry may go
  (`limits.ts`: metres within reach of a frame's origin, how many points,
  a drawing's scale, a turn kept from 0 to below 360) — the one set of
  limits the API, a configuration file's reader and an import hold to.
- **Does not:** draw — the map component in `@kraftverk/ui` does, on each
  platform; hold or serve tiles — the server does, from its disk; know any
  device, or where anyone is: it is given what to show.

## Where it fits

A shared package low in the layers: it imports the SDK alone, no React and
no platform, and runs anywhere. `@kraftverk/ui` draws with it; the server
serves the tiles and regions it describes.

## Why a package of its own

Because a map is wanted by more than phones — a home's place, zones, several
devices on one map — and its style, its shapes and its regions are the same
wherever it is drawn: written once, under the renderers, not in any one of
them.
