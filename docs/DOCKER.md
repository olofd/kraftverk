# Running the server in Docker

One container, one volume, and an app in a browser pointed at it.

This image runs **the server only** — the API, the MQTT broker, history sampling,
the plugin host and the action gateway. It does not serve the app, and does not
need to: the app is a browser client that you point at a server's address under
**App settings**, which is exactly what that flow was built for. Running the
server on a machine that is always on is the whole reason it exists — history and
automations need something awake while the app is closed.

> Read the hardware warning in the [README](../README.md#-this-software-can-permanently-destroy-your-power-station)
> first. A container does not make an undocumented BMS protocol safer.

---

## Quick start

```bash
docker compose up -d --build
```

Then open the app, go to **App settings → Servers**, and add
`http://<the-docker-host>:3333`. The canvas is blank until you add a device —
nothing is adopted for you.

To check it came up:

```bash
curl http://localhost:3333/api/health
```

`{"ok":true}` and you are running. The container also has a `HEALTHCHECK`, so
`docker ps` will show `healthy` once it has answered.

---

## What the defaults are, and why

The compose file starts the **simulator** with **writes refused**. Both are
deliberate.

`READ_ONLY` matters more than it looks. On a developer's machine the hardware
modes get `--read-only` from the npm scripts; in a container there are no npm
scripts, and the server's own default is *writes allowed*. So `READ_ONLY: "1"`
is set explicitly rather than left to a default that means the opposite of what
the rest of the project does. Turn it off when you have read your registers and
decided to accept the risk — not before.

---

## Choosing a transport

| `STATION_DRIVER` | What it is | Works in this image |
| --- | --- | --- |
| `sim` | The built-in simulator | ✅ Default. No hardware needed |
| `device` | Real hardware over Wi-Fi, through the embedded MQTT broker | ✅ The one to use for a real deployment |
| `ble` | Real hardware over Bluetooth LE | ❌ Not in this image — see below |

### Wi-Fi / MQTT — the one that suits a server

The station will not speak to your server until its DNS is redirected, because
it is hard-coded to reach the vendor's broker.

1. Set `STATION_DRIVER: device` in `docker-compose.yml` and restart.
2. In your router, Pi-hole, or whatever resolves DNS on that network:

   ```
   mqtt.sydpower.com  ->  <the Docker host's LAN IP>
   ```

3. Power-cycle the station so it re-resolves.
4. Add it in the app under **Your devices → Add a device → Power station**.

Port `1883` must be reachable **on the host's LAN address**, not just from
localhost — the station is a separate device on the network. The compose file
publishes it; check your host firewall separately.

The station still needs internet on its first connect: it fetches MQTT
credentials from the vendor cloud before connecting. Only the MQTT traffic is
redirected.

### Why Bluetooth is not here

`@stoprocent/noble` is declared an **optional dependency** and the image installs
with `--omit=optional`, which is what keeps four native builds — node-gyp, usb,
bluetooth-hci-socket, serialport — out of it. The server imports noble lazily, so
`sim` and `device` never reach for it and nothing is lost.

That is not merely a build convenience. A container has no honest access to a
Bluetooth radio:

- **On Docker Desktop (macOS, Windows)** the container runs inside a VM with no
  Bluetooth passthrough. It cannot work, and no flag makes it work.
- **On Linux** it is possible in principle — host networking, `CAP_NET_RAW` and
  `CAP_NET_ADMIN`, access to the host's BlueZ stack, and an image rebuilt without
  `--omit=optional`. It is fiddly, it is one more thing between you and a radio
  that already only accepts one connection at a time, and it is not something
  this repository tests.

If you want Bluetooth, run the server on the host with `npm run dev:ble`, or let
the app hold the link itself from a browser. Use MQTT for the container.

---

## Environment

Set these in `docker-compose.yml` under `environment:`, or in a `.env` file
beside it.

| Variable | Default | Meaning |
| --- | --- | --- |
| `STATION_DRIVER` | `sim` | `sim` or `device`. `ble` is not available — see above |
| `READ_ONLY` | `1` in compose | `1` refuses every write at the driver |
| `KRAFTVERK_SECRET_KEY` | — | Passphrase for AES-256-GCM plugin secrets. **Set this.** See below |
| `ALLOWED_ORIGINS` | — | Extra browser origins, comma-separated. Loopback and private ranges are already allowed |
| `AUTO_BIND` | on | `0` waits for an explicit bind instead of taking the first station found |
| `DEVICE_ID` | — | Bind this station rather than auto-binding |
| `PORT` / `HOST` | `3333` / `0.0.0.0` | The API. Both are set in the image |
| `MQTT_PORT` / `MQTT_HOST` | `1883` / `0.0.0.0` | The embedded broker |
| `ALLOW_RAW_MODBUS` | — | `1` enables arbitrary frames. Bad writes can brick the station |
| `KRAFTVERK_DB` | `/data/kraftverk.db` | Set in the image; leave it |
| `KRAFTVERK_BASELINE_FILE` | `/data/baseline.json` | Set in the image, so a register baseline survives a restart |

### Secrets

Without `KRAFTVERK_SECRET_KEY`, plugin secrets — a Tuya plug's local key, for
instance — are stored **as given**. The app says so plainly on the Extensions
screen rather than implying a protection it does not have. Set it to a long
random string:

```bash
openssl rand -base64 32
```

Put it in a `.env` file next to `docker-compose.yml` and uncomment the line that
reads it. Keep it somewhere other than the repository, and understand that
changing it later makes existing secrets unreadable — they must be re-entered.

### CORS

The API has **no authentication**. CORS is restricted to loopback and private
ranges, which covers a phone or laptop on the same network reaching a container
on that network, so the common case needs nothing.

Name any other origin the app is served from — a hostname, a reverse proxy — in
`ALLOWED_ORIGINS`. Setting it to `*` restores the old reflect-anything behaviour
and is a bad idea on a server whose `/grid/relay` route switches mains power.

**CORS is a browser rule, not a lock.** Anything on your LAN can call this API
directly. Keep it on your LAN. Never port-forward it.

---

## Data

Everything that outlives a restart is in the `kraftverk-data` volume, mounted at
`/data`: your devices, their recorded history, plugin configuration, secrets, the
audit timeline and any register baseline.

Back it up:

```bash
docker run --rm -v kraftverk-data:/data -v "$PWD:/backup" busybox tar czf /backup/kraftverk-data.tgz -C /data .
```

Deleting the volume resets you to a blank canvas, which is also the fastest way
to test the add-device flow from scratch.

---

## Operating it

```bash
docker compose logs -f          # what it is doing
docker compose restart          # after changing environment
docker compose up -d --build    # after pulling new code
docker compose down             # stop; the volume survives
```

`STATION_DRIVER` is read once at startup and cannot be changed from any screen —
the Station link screen reports the transport, it does not choose it. If it says
`Simulator` and you expected Bluetooth or Wi-Fi, the container was started with
the wrong `STATION_DRIVER`.

---

## Serving the app

Not covered by this image, and worth being straight about: there is no static web
build wired up yet. Today the app is run from a developer machine with
`npm run web`, or from a phone. Both can point at a containerised server by
adding its address under **App settings → Servers** — the address list lives in
the browser, so one build serves every server you own.

If you want the app served from the same host, `expo export --platform web` in
`client/` produces a static bundle you can hand to any web server, and
`EXPO_PUBLIC_API_URL` bakes in a default server address. Neither is exercised by
this repository yet; treat it as a starting point rather than a supported path.

---

## Troubleshooting

**`healthy` never arrives.** `docker compose logs` — the server prints its
listening address on the first line. If the port is already taken on the host,
the container will keep restarting.

**The station never appears with `STATION_DRIVER=device`.** In order: is
`mqtt.sydpower.com` actually resolving to the Docker host from *the station's*
network, has the station been power-cycled since, is `1883` reachable from
another machine on the LAN, and did the station have internet on first connect.
`GET /api/diagnostics/traffic` shows frames as they arrive, which distinguishes
"nothing is connecting" from "connecting but not understood".

**The app says it cannot reach the server.** Check the address you added includes
the scheme and port — `http://192.168.1.50:3333` — and that you are reaching it
from an origin CORS allows. A browser console error mentioning
`Access-Control-Allow-Origin` means `ALLOWED_ORIGINS`.

**Writes are refused.** That is `READ_ONLY: "1"`, and it is the default here on
purpose.
