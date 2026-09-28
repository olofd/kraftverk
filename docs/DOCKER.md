# Running kraftverk in Docker

Three containers, two images, one volume — and the app in a browser.

| Service | Image | What it does |
| --- | --- | --- |
| `web` | `--target web` | Serves the app, and forwards `/api` to the server. The only thing you open in a browser |
| `kraftverk` | `--target server` | The API, a session for every device, history sampling and the action gateway |
| `broker` | `--target server` | The MQTT broker stations connect to — its own container, so restarting or upgrading the server does not drop the station. See [BROKER.md](BROKER.md) |

Running this on a machine that is always on — a NAS — is the point: history and
automations need something awake while the app is closed.

> Read the hardware warning in the [README](../README.md#-this-software-can-permanently-destroy-your-power-station)
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

The compose file starts the **simulator** with **writes refused**. Both are
deliberate.

`READ_ONLY` matters more than it looks. On a developer's machine the hardware
modes get `--read-only` from the npm scripts; in a container there are no npm
scripts, and the server's own default is *writes allowed*. So `READ_ONLY=1` is
the compose default rather than a default that means the opposite of what the
rest of the project does. Turn it off when you have read your registers and
decided to accept the risk — not before.

---

## The two entrances

The web container listens twice, and the difference matters:

| Port | Entrance | Published on |
| --- | --- | --- |
| `8080` | the home network | the host's LAN address |
| `8090` | the internet | the host's **loopback only** — for a reverse proxy on the same machine |

Every request forwarded to the server is stamped with the entrance it came
through. It decides one thing: the first account on a fresh server can only be
created through the home network's. Everything else needs a login either way.
Two tripwires make a mistake fail safe — a request on the home entrance that
has been through a proxy, or that is addressed by a public name, is treated as
the internet. See [SECURITY.md](SECURITY.md).

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

## Choosing a transport

| `STATION_DRIVER` | What it is | Works in this image |
| --- | --- | --- |
| `sim` | Every device simulated; no hardware is reached | ✅ Default. No hardware needed |
| `mqtt` | Real hardware: stations over Wi-Fi through the `broker` service, plus plugs on the home network and web services such as the weather | ✅ The one to use for a real deployment |
| `ble` | Real hardware over Bluetooth LE | ❌ Not in this image — see below |

Every hardware mode also gets the home network (`lan`) and `https`, which
need nothing of the machine. `KRAFTVERK_TRANSPORTS=mqtt,lan,https` names them
outright instead. A plug on the home network is reached from the container over
TCP; its UDP announcements may not reach a bridged container, so give its IP
address by hand when it is not found.

### Wi-Fi / MQTT — the one that suits a server

The station connects to the vendor's broker until it is told otherwise.

1. Set `STATION_DRIVER=mqtt` in a `.env` file beside `docker-compose.yml`, and
   restart. (`device` means Wi-Fi *and* Bluetooth; this image has no
   Bluetooth, so it works but reports a failed transport on every start.)
2. Point the station at the Docker host, one of two ways:
   - **BrightEMS 1.6.0+**: *Me → Settings → Local MQTT Broker Settings*, and
     enter the Docker host's LAN IP. Only the master account can change it.
   - **Older firmware**: in your router, Pi-hole, or whatever resolves DNS on
     that network, point `mqtt.sydpower.com` at the Docker host's LAN IP, then
     power-cycle the station so it re-resolves.
3. `docker compose logs -f broker` shows it arrive: the TCP connection, the
   MQTT handshake, its first frames.
4. Add it in the app under **Your devices → Add a device → Power station**.

Port `1883` must be reachable **on the host's LAN address**, not just from
localhost — the station is a separate device on the network. Check the host
firewall separately.

The station still needs internet on its first connect: it fetches its settings
from the vendor cloud before connecting. Only the MQTT traffic is redirected.

### Why Bluetooth is not here

`@stoprocent/noble` is declared an **optional dependency** and the image installs
with `--omit=optional`, which is what keeps four native builds — node-gyp, usb,
bluetooth-hci-socket, serialport — out of it. The server imports noble lazily, so
`sim` and `mqtt` never reach for it and nothing is lost.

That is not merely a build convenience. A container has no honest access to a
Bluetooth radio:

- **On Docker Desktop (macOS, Windows)** the container runs inside a VM with no
  Bluetooth passthrough. It cannot work, and no flag makes it work.
- **On Linux** it is possible in principle — host networking, `CAP_NET_RAW` and
  `CAP_NET_ADMIN`, access to the host's BlueZ stack, and an image rebuilt without
  `--omit=optional`. It is fiddly, and not something this repository tests.

If you want Bluetooth, run the server on the host with `npm run dev:ble`, or let
the app hold the link itself from a browser.

---

## Environment

In a `.env` file beside `docker-compose.yml`. It holds this installation's
settings and secrets: keep it out of any repository, readable only by you.

| Variable | Default | Meaning |
| --- | --- | --- |
| `STATION_DRIVER` | `sim` | `sim`, or `mqtt` for a station over Wi-Fi. `ble` is not available — see above |
| `READ_ONLY` | `1` | `1` refuses every write at the driver. Only `0` allows them |
| `KRAFTVERK_SECRET_KEY` | — | Passphrase for AES-256-GCM secrets, such as a plug's local key. **Set this.** See below |
| `KRAFTVERK_ALLOWED_HOSTS` | — | The public name the server is reached by, if any — a DDNS name. Comma-separated |
| `KRAFTVERK_LAN_PORT` | `8080` | Where the home network opens the app |
| `KRAFTVERK_PUBLIC_PORT` | `8090` | Where the reverse proxy forwards the internet to, on loopback |
| `KRAFTVERK_MQTT_PORT` | `1883` | Where stations connect |
| `KRAFTVERK_API_PORT` | `3333` | The server's own port, on loopback |
| `KRAFTVERK_SERVER_IMAGE` / `KRAFTVERK_WEB_IMAGE` | `kraftverk-server` / `kraftverk-web` | Images to run — built here by default, or pulled from a registry by a deploy |

Set in the compose file, and best left alone: `BROKER_SPAWN=0`, `BROKER_HOST`,
`BROKER_ADMIN_URL` (how the server finds the broker service) and
`KRAFTVERK_TRUSTED_PROXIES=web` (whose entrance stamp is believed). Set in the
image: `KRAFTVERK_DB`, `KRAFTVERK_BROKER_DIR` and `KRAFTVERK_LOG_DIR`, all
under `/data`. `ALLOW_RAW_MODBUS=1` lets the station's raw-frame tool send
arbitrary frames; bad writes can brick the station.

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
| `kraftverk.db` | Devices and how each is reached, their secrets, recorded history, accounts, the audit timeline ([DATA-MODEL.md](DATA-MODEL.md)) |
| `logs/server-YYYY-MM-DD.log` | The server's log, one file a day, two weeks kept |
| `broker/logs/broker-YYYY-MM-DD.jsonl` | The broker's journal: every connection, frame and disconnect |
| `broker/` | The broker's token and the stations it has seen |
| `baseline.json` | A register baseline, if one was taken |
| `kraftverk.db.before-migration-N.<time>` | The database as it was before an upgrade changed its schema: the way back from a bad one |

Back it up:

```bash
docker run --rm -v kraftverk_kraftverk-data:/data -v "$PWD:/backup" busybox tar czf /backup/kraftverk-data.tgz -C /data .
```

**Upgrades copy the database first.** Before a new version changes the
database's schema, the server copies it beside itself and logs where. Rolling
back is stopping the stack, putting that copy in place of `kraftverk.db`, and
starting the previous image. The copies are not removed automatically; delete
old ones once the new version has been running for a while.

(The volume is named after the compose project: `kraftverk_kraftverk-data` when
the project is `kraftverk`. `docker volume ls` shows it.)

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

`STATION_DRIVER` is read once at startup and cannot be changed from any screen.
If **App settings → Transports** says the server runs the simulator and you
expected Wi-Fi, the container was started with the wrong `STATION_DRIVER`.

---

## Troubleshooting

**`healthy` never arrives.** `docker compose logs <service>` — the server prints
its listening address on the first line. A port already taken on the host keeps
the container restarting.

**The station never appears with `STATION_DRIVER=mqtt`.** Start with
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
