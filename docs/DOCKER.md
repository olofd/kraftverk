# Running kraftverk in Docker

Three containers, two images, one volume — and the app in a browser.

| Service | Image | What it does |
| --- | --- | --- |
| `web` | `--target web` | Serves the app, and forwards `/api` to the server. The only thing you open in a browser |
| `kraftverk` | `--target server` | The API, a session for every device, history sampling and the action gateway |
| `broker` | `--target server` | The MQTT broker stations connect to — its own container, so restarting or upgrading the server does not drop the station. See [BROKER.md](BROKER.md) |

Running this on a machine that is always on — a NAS — is the point: history and
automations need something awake while the app is closed.

> Read the hardware warning in the [station's README](../packages/devices/aferiy-p280/README.md#this-software-can-permanently-destroy-your-power-station)
> first. A container does not make an undocumented BMS protocol safer.

---

## Quick start

```bash
docker compose up -d --build
```

Open `http://<the-docker-host>:8080`. A fresh server asks you to create the
first administrator — from the home network only — and after that everyone
signs in. The canvas is blank until you add a device; nothing is adopted for
you.

`docker compose ps` shows all three `healthy` once they have answered their
health checks.

---

## What the defaults are, and why

The compose file starts with **writes to hardware refused**. That is
deliberate.

`READ_ONLY` matters more than it looks. On a developer's machine the dev
scripts pass `--read-only`; in a container there are no npm
scripts, and the server's own default is *writes allowed*. So `READ_ONLY=1` is
the compose default rather than a default that means the opposite of what the
rest of the project does. Turn it off when you have read your registers and
decided to accept the risk — not before.

---

## The entrances

The web container listens three times, and the difference matters:

| Port | Entrance | Published on |
| --- | --- | --- |
| `8080` | the home network | the host's LAN address |
| `8081` | the home network, through a reverse proxy on the same machine — one that gives each service a name of its own (`kraftverk.local`) | the host's **loopback only** |
| `8090` | the internet | the host's **loopback only** — for a reverse proxy on the same machine that terminates HTTPS |

Every request forwarded to the server is stamped with the entrance it came
through. It decides one thing: the first account on a fresh server can only be
created through the home network's. Everything else needs a login either way.
Two tripwires make a mistake fail safe — a request on the home entrance that
has been through a proxy, or that is addressed by a public name, is treated as
the internet. See [SECURITY.md](SECURITY.md).

`8081` is for a server that runs several services behind one proxy, each by a
name of its own. Only a proxy on the host can reach it, so having been through
one is expected there, and the address the proxy reports is the caller's. The
proxy's part is to forward only the home network's names to `8081`, and a
public name to `8090`; the server's own tripwire still treats a request
addressed by a public name as the internet.

The server's own port, `3333`, is published on the host's loopback only, for
the recovery CLI and diagnostics there. Browsers go through `web`.

### Reaching it from outside

Put a reverse proxy that terminates HTTPS in front of port `8090`. On a
Synology:

1. **Control Panel → Login Portal → Advanced → Reverse Proxy → Create.**
   Source: HTTPS, a name under your DDNS name — `kraftverk.<you>.synology.me`,
   which Synology's DDNS resolves too, leaving the bare name to DSM — port 443.
   Destination: HTTP, `localhost`, port `8090`.
   **Custom Header → Create**: `X-Forwarded-For` = `$proxy_add_x_forwarded_for`
   and `X-Real-IP` = `$remote_addr`, so the server rate-limits and records the
   real client rather than the proxy.
   **Custom Header → Create → WebSocket**, which adds the two headers a
   WebSocket needs through a proxy: the app's live stream uses one. Without
   them the app still works from outside, and reads the list every five
   seconds instead.
   **Advanced Settings**: raise the proxy read timeout from 60 to 120 seconds.
   A setup step can take up to 90 seconds (a network scan, a cloud login), and
   a proxy that gives up first reports a failure for something that went on to
   work.
2. **Control Panel → Security → Certificate → Settings**: give the new entry a
   certificate covering that name. The Let's Encrypt certificate DSM makes for
   a `synology.me` name includes `*.<you>.synology.me`.
3. Set `KRAFTVERK_ALLOWED_HOSTS` to that name, or the server refuses requests
   under it.
4. Forward TCP 443 on the router to the NAS — and nothing else.

Never forward `8080`, `3333` or `1883`. (If `8080` is forwarded by mistake,
the server still treats whatever arrives by the router's public address as the
internet — but nothing else about that entrance was made for it.)

---

## How devices are reached

Nothing to choose here: every transport in the image is available, and each
device is reached the way you added it.

| Transport | What it reaches | In this image |
| --- | --- | --- |
| Wi-Fi (MQTT) | Stations over Wi-Fi, through the `broker` service | ✅ The one that suits a server |
| Home network (`lan`) | Plugs and other devices on your network, over TCP | ✅ |
| HTTPS | Web services, such as the weather | ✅ |
| Bluetooth LE | Devices within radio range | ✅ On a Linux host with BlueZ — see [Bluetooth](#bluetooth); not on Docker Desktop, and the Connectivity screen says so |

**Simulated** is a way to add any device, with no hardware: its type's
simulator stands in for it. A simulated device sits beside real ones, reaches
nothing, and takes writes even when writes to hardware are refused.

A plug on the home network is reached from the container over TCP. What
devices announce — a broadcast, mDNS, SSDP — does not reach a container: it
is heard by the relay, below, and the device is offered as found.

### The relay

Every service but one runs on Docker's own network, isolated from the home
network. The `relay` is the one on the host's network itself (`network_mode:
host`), because that is the only place devices that announce themselves are
heard: a Tuya plug's UDP broadcast, an Apple TV's or a Chromecast's mDNS
services, a TV's SSDP. It is the gateway between outside and inside — for
hearing only:

- **What passes.** One TCP connection, which the relay makes to the server on
  `127.0.0.1:${KRAFTVERK_RELAY_PORT:-3334}` (published on the host's
  loopback only). The server tells it what to listen for — the matchers the
  installed integrations declare — and it answers with what it hears, typed:
  each host, and what it announced. Nothing else crosses
  (`packages/transports/lan/src/relay.ts` is the whole of it).
- **What it may do.** Listen, and ask: an mDNS question, an SSDP search, now
  and then. It opens nothing to a device — the server makes every
  connection, from inside — holds no database and no secret but its token,
  and runs no integration's code.
- **Its token.** The server makes it the first time it starts, in the
  `kraftverk-relay` volume the two share and nothing else; the relay mounts
  it read-only. A relay that does not give it is refused.
- **When it is not there.** Devices are reached as before; only what they
  announce is not heard, and the server's log says the relay went away.

Later, other radios plugged into the host — a Zigbee or Thread dongle — are
services at this edge too, each its own container with one narrow connection
to the server, as the broker and the relay are (docs/PLAN-INTEGRATIONS.md,
§12, after step 13).

### Wi-Fi / MQTT — the one that suits a server

The station connects to the vendor's broker until it is told otherwise.

1. Point the station at the Docker host, one of two ways:
   - **BrightEMS 1.6.0+**: *Me → Settings → Local MQTT Broker Settings*, and
     enter the Docker host's LAN IP. Only the master account can change it.
   - **Older firmware**: in your router, Pi-hole, or whatever resolves DNS on
     that network, point `mqtt.sydpower.com` at the Docker host's LAN IP, then
     power-cycle the station so it re-resolves.
2. `docker compose logs -f broker` shows it arrive: the TCP connection, the
   MQTT handshake, its first frames.
3. Add it in the app under **Your devices → Add a device → Power station**.

Port `1883` must be reachable **on the host's LAN address**, not just from
localhost — the station is a separate device on the network. Check the host
firewall separately.

The station still needs internet on its first connect: it fetches its settings
from the vendor cloud before connecting. Only the MQTT traffic is redirected.

### Bluetooth

On a Linux host the server reaches the radio through **BlueZ**, the Bluetooth
stack the host already runs, over its **system D-Bus**: `/run/dbus` is mounted
into the server container (read-only, which still lets it connect), and the
transport talks to `org.bluez` with a pure-JavaScript D-Bus client. No host
networking, no capabilities, no native code — and BlueZ keeps the adapter,
shared rather than fought over. BlueZ's own D-Bus policy lets any user ask it
for what a central does (scan, connect, read, write, notify); nothing on the
host needs changing. The log says `[ble] Scanning for Bluetooth devices,
through BlueZ`.

The host needs a radio BlueZ sees (`bluetoothctl list`) and `bluetooth.service`
running. A radio switched off is switched on.

noble, which drives a radio itself, stays an **optional dependency**, and the
image installs with `--omit=optional`, which keeps its four native builds —
node-gyp, usb, bluetooth-hci-socket, serialport — out. It is for a server run
on Windows or macOS with `npm run dev`.

**On Docker Desktop (macOS, Windows)** the container runs inside a VM with no
Bluetooth passthrough and no BlueZ: the transport says it is unavailable, and
every other one carries on. Run the server on the host instead, or let the app
hold the link itself from a browser.

### Zigbee

A Zigbee USB dongle on the host — a Sonoff ZBDongle-P (TI CC2652P, Z-Stack),
or a ZBDongle-E (Silicon Labs, `ember`) — is driven by **Zigbee2MQTT** in a
container of its own, `zigbee2mqtt`, which speaks to the broker above,
signed in. kraftverk is its interface: it has no web page of its own and no
Home Assistant discovery. Why Zigbee2MQTT, and what kraftverk does with it:
[PLAN-ZIGBEE.md](PLAN-ZIGBEE.md).

1. In the deploy's environment (`scripts/deploy.env.example`):
   - `COMPOSE_PROFILES=zigbee` — the service is started only with it;
   - `KRAFTVERK_ZIGBEE_ADAPTER` — the dongle by its stable path,
     `/dev/serial/by-id/usb-…-if00-port0` (`ls /dev/serial/by-id/` on the
     host), never `/dev/ttyUSB0`, which changes with what else is plugged in;
   - `KRAFTVERK_ZIGBEE_ADAPTER_TYPE` — `zstack` (the default) or `ember`;
   - `KRAFTVERK_ZIGBEE2MQTT_PASSWORD` — what Zigbee2MQTT signs in to the
     broker with (`openssl rand -base64 24`). The broker gets it too
     (`KRAFTVERK_BROKER_CLIENTS`): only Zigbee2MQTT, signed in, may speak for
     a Zigbee device, and only the server may command one.
2. Deploy. The broker is recreated if it does not apply the Zigbee2MQTT
   protocol yet (the station is gone for about a minute), then Zigbee2MQTT
   starts. On its first start it writes its configuration — a new network key
   among it — into its volume, `zigbee2mqtt-data`.
3. In the app, **Integrations → Zigbee2MQTT** offers the coordinator, found
   when Zigbee2MQTT connects. Add it, then **Let devices join** on its page
   and put each device in pairing mode: it appears under *Through it*, and
   is added from there.

**The volume is the network.** Its key and what is paired live in
`zigbee2mqtt-data`, not in kraftverk's database: setting kraftverk's
database aside pairs nothing again, losing this volume pairs everything
again. Back it up with the host's data; the coordinator's page also has
*Back up the network*.

`docker compose logs -f zigbee2mqtt` says what it is doing — the dongle
found, devices joining and interviewed. A dongle it cannot open is said
there first: the wrong path, or another program holding it.

---

## Environment

In a `.env` file beside `docker-compose.yml`. It holds this installation's
settings and secrets: keep it out of any repository, readable only by you.

| Variable | Default | Meaning |
| --- | --- | --- |
| `READ_ONLY` | `1` | `1` refuses every write to hardware. Only `0` allows them. Simulated devices take writes either way |
| `KRAFTVERK_SECRET_KEY` | — | Passphrase for AES-256-GCM secrets, such as a plug's local key. **Set this.** See below |
| `KRAFTVERK_ALLOWED_HOSTS` | — | The public name the server is reached by, if any — a DDNS name. Comma-separated |
| `KRAFTVERK_LAN_PORT` | `8080` | Where the home network opens the app |
| `KRAFTVERK_PUBLIC_PORT` | `8090` | Where the reverse proxy forwards the internet to, on loopback |
| `KRAFTVERK_MQTT_PORT` | `1883` | Where stations connect |
| `COMPOSE_PROFILES` | — | `zigbee` starts Zigbee2MQTT, where a dongle is plugged in (*Zigbee*, above) |
| `KRAFTVERK_ZIGBEE_ADAPTER` | — | The Zigbee dongle, by its `/dev/serial/by-id/` path |
| `KRAFTVERK_ZIGBEE_ADAPTER_TYPE` | `zstack` | `zstack` for a TI coordinator (ZBDongle-P), `ember` for Silicon Labs (ZBDongle-E) |
| `KRAFTVERK_ZIGBEE2MQTT_PASSWORD` | — | What Zigbee2MQTT signs in to the broker with; the broker is given it too. None: Zigbee2MQTT cannot speak for its devices |
| `KRAFTVERK_API_PORT` | `3333` | The server's own port, on loopback |
| `KRAFTVERK_SERVER_IMAGE` / `KRAFTVERK_WEB_IMAGE` | `kraftverk-server` / `kraftverk-web` | Images to run — built here by default, or pulled from a registry by a deploy |

Set in the compose file, and best left alone: `BROKER_SPAWN=0`, `BROKER_HOST`,
`BROKER_ADMIN_URL` (how the server finds the broker service) and
`KRAFTVERK_TRUSTED_PROXIES=web` (whose entrance stamp is believed). Set in the
image: `KRAFTVERK_DB`, `KRAFTVERK_BROKER_DIR` and `KRAFTVERK_LOG_DIR`, all
under `/data`. `ALLOW_RAW_FRAMES=1` lets a device type's raw-frame tool send
arbitrary frames; bad writes can brick a device.

### Secrets

Without `KRAFTVERK_SECRET_KEY`, secrets — a Tuya plug's local key, for
instance — are stored **as given**. The app says so plainly where the secret is
entered, rather than implying a protection it does not have. Set it to a long
random string:

```bash
openssl rand -base64 32
```

Changing it later makes existing secrets unreadable — they must be re-entered.

---

## Data

Everything that outlives a restart is in the `kraftverk-data` volume, mounted at
`/data` in the server and the broker:

| Path | What |
| --- | --- |
| `kraftverk.db` | Devices and how each is reached, their secrets, recorded history, the audit timeline ([DATA-MODEL.md](DATA-MODEL.md)) — and the accounts and their sessions, which live nowhere else ([SECURITY.md](SECURITY.md#where-accounts-live)) |
| `config/kraftverk.yaml` | The home's configuration, kept beside the database: devices, how each is reached and their secrets, links, automations, the home's values — never accounts. Written after every change, the five before it kept as `.1` … `.5` ([CONFIG.md](CONFIG.md#where-it-is-kept)) |
| `node-id` | Which kraftverk node this server is, so a new database is still the same node |
| `logs/server-YYYY-MM-DD.log` | The server's log, one file a day, two weeks kept |
| `broker/logs/broker-YYYY-MM-DD.jsonl` | The broker's journal: every connection, frame and disconnect |
| `broker/` | The broker's token and the stations it has seen |
| `map/world-YYYYMMDD.pmtiles` | The world's map, roughly (45 MB): downloaded when the server first starts |
| `map/regions/` | The countries downloaded in full detail — the home's, or one before a journey — from **App settings → Maps** |
| `map/cache.db` | The detail fetched as someone looks where no region is held: 2 GB at most, the least used let go |
| `map/assets/` | The map's fonts and icons, fetched with the world |
| `baseline.json` | A register baseline, if one was taken |
| `kraftverk.db.set-aside.<time>` | A database made by an earlier schema, set aside untouched when a new version started a new one: the way back from a bad upgrade |

Back it up:

```bash
docker run --rm -v kraftverk_kraftverk-data:/data -v "$PWD:/backup" busybox tar czf /backup/kraftverk-data.tgz -C /data .
```

**A new schema sets the database aside.** The database has one schema and
no migrations: when a new version changes it, the server moves the old file
beside the new one, unchanged, and logs where. What a new schema keeps:

- **The home** — devices, how each is reached and their secrets (sign-ins to
  a cloud account included), links, automations and the home's values. It
  is restored from `config/kraftverk.yaml`.
- **The accounts** — the same names and passwords. They are copied from the
  database being set aside into the new one. Everyone is signed out, so sign
  in again. If the accounts' own table changed so that they cannot be
  carried, the log says so, and the first account is made again from the
  home network.
- **Not kept:** history, the timeline, what automations remember, and their
  runs. These stay in the file set aside.

Rolling back means stopping the stack, putting the file set aside in place of
`kraftverk.db`, and starting the previous image. The files are not removed
automatically. Delete old ones once the new version has been running for a
while. They hold the accounts' password hashes too.

(The volume is named after the compose project: `kraftverk_kraftverk-data` when
the project is `kraftverk`. `docker volume ls` shows it.)

### The map

Nothing to set up ([PLAN-MAPS.md](PLAN-MAPS.md)). The image carries the
`pmtiles` tool, pinned by its checksum. On its first start the server
downloads the world's map from Protomaps' daily build of OpenStreetMap, with
its fonts and icons. **App settings → Maps** offers the home's country in full
detail once the home's place is said, and any other country before a journey.
Each one's size is said before it is downloaded. Where no region is held, the
server fetches the detail someone looks at and keeps it. That can be switched
off there. The server needs `build.protomaps.com` and `github.com` on
the internet for this. Without them the map is the world, roughly, or none at
all, and everything else works as before. The browser itself only ever asks
this server. Outside Docker, put `pmtiles` on the `PATH` or point
`KRAFTVERK_PMTILES` at it.

### Resetting without touching the volume

Write a passphrase of at least sixteen characters to `/data/reset-secret` and
the app offers **App settings → Danger zone → Erase everything**, which empties
every table but the accounts while the container keeps running. Wrong
passphrases are counted like wrong passwords, and slowed down the same way:

```bash
docker compose exec kraftverk sh -c 'printf "%s" "a-long-passphrase-of-your-own" > /data/reset-secret'
```

Without that file the route does not exist at all. Delete the file to switch it
off again — it is read on each attempt, so nothing needs restarting either way.
Erasing needs a signed-in account as well as the passphrase: a stolen session
alone cannot erase the house.

---

## Diagnosing a problem

Start in the app — **App settings → Server log** for the server, and the
station's **Protocol** screen for the broker's journal: what the station did,
and why each connection ended. Both need only a browser.

When the app itself is the problem, or you need more than the last few hundred
lines, sign in to the machine (`ssh` to the NAS) and go to the directory with
`docker-compose.yml`:

```bash
docker compose ps                        # is everything up and healthy?
docker compose logs --tail 200 kraftverk # the server's console
docker compose logs -f broker            # the station's story, live
docker compose logs --tail 100 web       # the web container: startup, proxy errors

# The broker's own view: stations, clients, why the last one left
docker compose exec broker bun run packages/transports/mqtt/src/broker/cli.ts status
# Its journal, from the files — including what happened before a restart
docker compose exec broker bun run packages/transports/mqtt/src/broker/cli.ts logs

# The server's kept log, older than the container
docker compose exec kraftverk ls /data/logs
docker compose exec kraftverk tail -n 300 /data/logs/server-$(date +%F).log
```

`docker compose logs` only reaches back to the container's last start, and a
deploy recreates the containers; the files under `/data/logs` and
`/data/broker/logs` survive both, for two weeks.

### Accounts

If nobody can sign in — every password forgotten — a shell on the server is
the proof of ownership:

```bash
docker compose exec kraftverk bun run server/src/auth/cli.ts list
docker compose exec kraftverk bun run server/src/auth/cli.ts password <name>
```

See [SECURITY.md](SECURITY.md#recovering-access).

### Operating it

New code is put in place by the pipeline, or by `scripts/deploy.sh` by hand,
which does what follows without dropping the station
([DEPLOY.md](DEPLOY.md)). The same, by hand with compose:

```bash
# After pulling new code: the server and the app, and nothing else.
docker compose up -d --build --no-deps kraftverk web

docker compose restart kraftverk   # after changing the server's environment; the station stays connected
docker compose down                # stop; the volume survives
```

The broker is left out of updates on purpose. It runs from the same image as
the server, so a plain `docker compose up -d --build` would recreate it for
every server change — and every time, drop the station, which may not come
back without a power-cycle. Update it only when the broker itself changed: the
Station link screen says so, as *the broker is running an older build*. Then,
at a moment when losing the station for a minute is fine:

```bash
docker compose up -d --build broker
```

The deploy (`scripts/deploy.sh`) does that itself when the broker's build is
not the images': a guard or a policy fixed is live once it is deployed. What
devices said and the broker keeps (`retained.json`) carries across.

**App settings → Connectivity** lists every transport and whether it runs
here, with the reason when one does not.

---

## Troubleshooting

**`healthy` never arrives.** `docker compose logs <service>` — the server prints
its listening address on the first line. A port already taken on the host keeps
the container restarting.

**The station never appears over Wi-Fi.** Start with
`docker compose logs broker`: the broker records every TCP connection before any
MQTT, so it distinguishes "nothing is connecting" from "connecting but failing
the handshake" from "connected but not understood". If nothing is connecting, in
order: is the Local MQTT Broker setting in BrightEMS the Docker host's LAN IP,
has the station been power-cycled since, is `1883` reachable from another
machine on the LAN, and did the station have internet on first connect.
[BROKER.md](BROKER.md#when-the-station-does-not-come-back) has the rest.

**The first account cannot be created.** Open the app on the home network, at
the host's LAN address — `http://192.168.1.50:8080`, not the DDNS name, which
the server deliberately treats as the internet. The sign-in screen says how the
server sees your device.

**"This server does not answer to that name".** The name in the address bar is
not an IP, a `.local` name or a single-label name, and is not in
`KRAFTVERK_ALLOWED_HOSTS`. That refusal is the DNS-rebinding defence.

**Writes are refused.** That is `READ_ONLY=1`, and it is the default here on
purpose.
