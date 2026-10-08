# Maps, where things are, and a phone's own screen

The plan for drawing where things are, on a map. It starts with phones and
the rest of Find My, and is built so that any device with a position, a
home's location or a zone uses the same map. 2026-10-08.

## 1. Why

A phone added through iCloud shows "59.62806° N, 17.70450° E ± 8 m" as a
card's headline, and the text runs out of its card. It does not say when it
was located, nor when it will be again. Nothing in kraftverk draws a map. The
owner wants:
- a phone drawn as a phone;
- where it is on a map, live while watched;
- where it has been, when they turn tracking on for that device;
- maps that work on every kraftverk, at home and abroad.

## 2. Decisions

- **Rendering: MapLibre.**
  - `maplibre-gl` v6 on the web, `@maplibre/maplibre-react-native` v11 on
    phones. Both read one style specification and the same GeoJSON, so one
    component sits over both.
  - Phones need a development build (as Bluetooth already does). Expo Go
    shows a still fallback: where it is, and how old that is.
  - The others were weighed and set aside:
    - react-native-maps has no web, and sends positions to Apple or Google;
    - expo-maps is alpha, with no web;
    - Leaflet is raster only, with no dark style left free;
    - a map of our own would mean writing pan, pinch and tiles ourselves.
- **Map data: Protomaps vector tiles, on the kraftverk server itself.**
  - PMTiles archives sit in the server's data folder. The server answers
    `/map/tiles/{z}/{x}/{y}.mvt` from them, with the style, fonts and
    sprites beside them.
  - The page asks only its own server: the Content-Security-Policy stays
    `'self'`, and no third party learns where anyone is looking.
  - Style: `@protomaps/basemaps`, dark. Map data © OpenStreetMap (ODbL),
    credited on every map.
- **Regions, managed by the server.**
  - Every kraftverk has a **world** archive (zoom 0–6, small), so a map shows
    anywhere at once.
  - Detail comes by **region**: a country, or a box, at zoom 0–14 (MapLibre
    draws closer views from zoom 14).
  - Downloaded by the server with Protomaps' `pmtiles` tool, which is in the
    image: an extract read from Protomaps' public daily build. A region's
    archive is about 2.5 GB for Sweden, less for most countries.
  - A tile is served from the most detailed region holding it, else from
    the world.
  - **Detail as you look,** on by default. A tile no region holds is read
    from Protomaps' build by byte range, by the server, and kept in a cache
    of 2 GB at most, the least used let go. So a map has detail wherever it
    is looked at, abroad included, with nothing downloaded first.
  - Protomaps then sees which tiles the server fetches, never the browser.
    It can be turned off under Maps: then only downloaded regions have
    detail.
  - In the app, under **App settings › Maps**: the regions held, their size
    and date, add (a country before a journey), refresh, remove, with
    progress.
  - A new kraftverk downloads the world at once, and offers the home's
    country, from the home's location.
  - The country list (ISO code, name, bounding box) is public data in a
    package. Which regions a kraftverk holds lives only on it.
- **Tracking: off, until turned on per device.**
  - A device with a position may keep where it has been: a setting of its
    own, **Keep where it has been**, with how long, from 1 day to 1 year.
  - Kept in a `track` table: device, time, latitude, longitude, accuracy.
    Pruned by that length. Never in an export, and gone when the device is
    removed.
  - Turning it off forgets what was kept.
  - Without it, nothing of where someone was is kept, as before.
- **Live while watched.** A phone's own page has its account ask Find My
  every minute. The home screen never does, since asking locates every
  device on the account, at a cost to their batteries.

## 3. The pieces, and where they live

- **`@kraftverk/map`, a new shared package.**
  - The style builder (`mapStyle({ origin, theme })` over
    `@protomaps/basemaps`).
  - GeoJSON for markers, accuracy circles (a polygon from metres), trails
    and zones.
  - The country list. Bounds and distance helpers.
  - Pure: no React, no platform.
- **The map component in `packages/ui`:** `Map.web.tsx` and `Map.native.tsx`,
  thin over the two renderers.
  - Its props: `markers`, `trails`, `zones`, `follow`, `fit`, `onPress`.
  - It eases the camera, follows a marker until the person pans, offers
    zoom and centre controls of at least 40 px, and credits the map data.
- **Tiles and regions in `server/`** (the disk is the server's):
  - `server/src/map/tiles.ts` reads archives by byte range, with the
    `pmtiles` library over the file.
  - `server/src/map/regions.ts` downloads, refreshes and removes regions
    with the `pmtiles` tool, and tracks progress.
  - Routes: `/map/style.json`, `/map/tiles/...`, `/map/fonts/...`,
    `/map/sprites/...`, and `/api/map/regions`.
- **Tracking: the `track` table in `packages/store`.** The hub writes a
  position for a device that keeps its track and prunes it hourly.
  `GET /api/devices/:id/track?since=` reads it, and the device's settings
  hold the switch and its length.
- **The phone's screen: `packages/integrations/icloud/ui/`.**
  - Find My devices' own screens, bound through `kraftverk.ui`.
  - Illustrations drawn for each kind of Apple device: iPhone, iPad, Mac,
    Watch, AirPods.

## 4. The phone's screen

From the top:
1. **The map.** Where it is, its accuracy as a circle, its trail when kept,
   home marked. The camera follows it until the person pans.
2. **Where and when.** "At home", or "2.3 km away". "Located 4 min ago ·
   looks again in about 11 min", ticking live. While open: "every minute
   while you watch".
3. **The device.** Its illustration, model and owner. Its charge as a
   battery, with a charging mark.
4. **Actions:**
   - **Play sound**;
   - **Locate now**, limited to once a minute;
   - **Lost mode**, which a person confirms.
5. **Tracking.** On or off, and for how long. A tap from here.

Its card on the home screen says the place and the charge, never raw
coordinates: "At home · 13 %", or "2.3 km away · 18 % charging", with when.

## 5. Also mended in this round

- **A card's headline never leaves its card,** at any width or value. It
  shrinks to fit, and a layout check guards it.
- **"Found near you"** shows one row for an account's undrawn devices ("23
  devices in your iCloud account's Find My"), not one row each.
- **A reading located afresh at the same spot** is shown with its new time.
  Until now "a new time alone is not a change", and the screen showed the
  old time.

## 6. Not in this round

- AirTags and other Find My items.
- The map on a phone. The app built for a phone draws where things are in
  words until `@maplibre/maplibre-react-native` is in a development build.

## Where it stands

2026-10-08: all seven steps are built and pushed. The world is served from
the NUC, and Sweden is held in full detail.

## 7. Order of work

Each step is green and pushed.

1. **Cards and the home screen.** The headline that fits, the place on a
   card, "Found near you" grouped, a fresh time shown.
2. **The phone's screen without a map.** Where, when, cadence, the device,
   actions, Locate now, every minute while watched.
3. **`@kraftverk/map` and the server's tiles.** The world archive, and the
   NUC's Sweden region served.
4. **The map component.** Web first, then native and the Expo Go fallback.
   The map on the phone's screen.
5. **Regions in the app.** Download, refresh, remove, progress. The world
   at setup, the home's country offered.
6. **Tracking.** The table, the setting, pruning, the trail on the map.
7. **The docs.** ARCHITECTURE's §3 package table, DATA-MODEL's `track`
   table, DOCKER's map data, SECURITY's tiles under `'self'`.
