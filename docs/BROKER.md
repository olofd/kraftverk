# The MQTT broker

The broker is what a power station connects to over Wi-Fi instead of the vendor
cloud. It runs as **its own process**, separate from the kraftverk server, and
it outlives the server on purpose.

In the architecture it is the `mqtt` **transport**: it moves messages and knows
who is connected, and nothing about what they mean. What a station's topics and
frames mean — and which commands must be refused, such as a write of 0 to
register 68 — belongs to the Sydpower **protocol**, which supplies them to the
broker (ARCHITECTURE.md §4.7). The broker lives in
`packages/transports/mqtt/src/broker/` and loads every installed protocol's
policy from `packages/protocols` at start — it refuses to start if one fails
to load, rather than run without a guard. A device's presence and messages are
filed under its protocol; nothing below changes for the station.

## Why it is a separate process

A P280 that loses its broker does not reliably come back. On 2026-09-26 it
reconnected by itself after two server restarts — once within two seconds — and
after a third made **no connection attempt at all** for six minutes while still
answering pings on Wi-Fi. Only a power-cycle brought it back. See
[P280-FINDINGS.md](P280-FINDINGS.md#connection-over-wi-fi).

While the broker lived inside the server, every edit restarted it: `--watch`
restarts the server process on each save, and `npm run dev` killed port 1883 on
the way in. Each of those was a broker outage, and each was a chance to lose the
station until someone walked over and power-cycled it.

So the broker is the thing that never restarts, and the server — which restarts
constantly — is a client of it:

```
  P280 ──MQTT :1883──▶  broker process  ◀──MQTT (privileged)── kraftverk server
                        (src/broker/)   ◀──HTTP :3883 admin──
                             │
                             └──▶ server/data/broker/logs/broker-YYYY-MM-DD.jsonl
```

## How it runs

**Nothing to do in development.** When the server starts with the Wi-Fi
transport (`dev:wifi`, `dev:device`, and their `:write` twins) it asks the
admin API whether a broker is running:

- **One is** → it attaches. The station has been connected to it all along,
  and the server restart was a non-event.
- **None is** → it starts one, **detached**, and waits for it to answer.
- **It dies while the server runs** → the server notices within five seconds
  and starts a new one, which takes a few more.

What the server **never** does is stop it. Stopping the server — Ctrl+C,
a crash, a `--watch` restart — leaves the broker running.

Detached means detached from the process tree, not just unreferenced.
`concurrently` stops `npm run dev` with a tree kill, which would take any
ordinary child with it. So the server starts a short-lived launcher
(`launcher.ts`), the launcher starts the broker, and the launcher exits: the
broker's parent no longer exists, and no tree kill aimed at the server reaches
it. Verified on Windows 11 with `taskkill /T /F`.

On Windows the launcher also creates the broker with `CreateProcessW` called
directly, with handle inheritance **off**. Otherwise the broker would inherit
the server's console pipes, which Windows passes to every child regardless of
what it was given as stdio, and `concurrently` would wait on a pipe the broker
holds open. (An earlier version used PowerShell's `Start-Process` for this, and
was dropped after PowerShell was seen hanging machine-wide. Starting the broker
now depends on nothing but Bun and `cmd`, and gives up after 15 s rather than
waiting for ever.)

**In Docker** the broker is its own service in `docker-compose.yml`, from the
same image, and the server is told not to start one (`BROKER_SPAWN=0`).
`docker compose restart kraftverk` leaves the station connected.

## Commands

```bash
npm run broker:status     # is it running, which build, which stations, why the last one left
npm run broker:logs       # follow the journal (Ctrl+C to stop following)
npm run broker -- logs --debug --station=AABBCC001122 -n 200   # every frame, one station
npm run broker:start      # start it if it is not running
npm run broker:stop       # stop it — this drops every station on it
npm run broker:restart    # load new broker code — also drops the station
npm run broker -- run     # run it in the foreground in this terminal
```

**Stopping it while a server runs does not stick.** Keeping a broker running is
the server's job, so it starts a new one within seconds — `broker:stop` says so
when a server is connected. To keep it stopped, stop the server first.

## A stale broker

The server fingerprints the broker's source files and compares that with what
the running broker reports. If you have edited broker code since it started,
the server says so — on startup, and on the station's Registers screen — and **leaves it
running**. Replacing it would drop the station, which is the decision this whole
design exists to keep in your hands. Run `npm run broker:restart` when that is
acceptable, and watch `npm run broker:logs` to see the station come back.

## The journal

Every event, with a sentence that stands on its own, in three places:

| Where | What | For |
| --- | --- | --- |
| `server/data/broker/logs/broker-YYYY-MM-DD.jsonl` | Everything, one JSON object per line, kept 14 days | What happened overnight |
| The server's terminal, prefixed `[broker]` | Info and above, live | Watching |
| The app: device **Settings → Advanced → Protocol** | The last 15 notable entries, plus recent frames | Checking from a phone |

What it records, so that "the station did not come back" can be answered with
evidence rather than a hypothesis:

| Event | Level | Tells you |
| --- | --- | --- |
| `tcp.open` / `tcp.close` | info (debug from loopback) | Whether the station opened a socket **at all** — before any MQTT. A close without a handshake is reported with the bytes exchanged. Loopback is the server or a port check, never a station |
| `mqtt.connected` | info (debug for the server) | Client id, keepalive, clean session, username, password *length* (never the password; a P280 sends none), will. The server's own session is journalled at debug: it reports its comings and goings itself |
| `mqtt.subscribe` | info | What it subscribed to. A station that has not subscribed to `<MAC>/client/request/#` cannot receive commands |
| `station.online` | info | Which station, from where, and **how long it had been away** |
| `station.offline` | warn | How long the session lasted and **why it ended**: a clean DISCONNECT, the TCP connection closed without one, a keepalive timeout, a socket error, replaced by a new connection with the same client id, or the broker shutting down |
| `station.absent` | warn | A known station has not reconnected after 1 min, 5 min, 15 min, 1 h, 6 h — measured from when it left, or from when this broker started |
| `command` | info (writes) / debug (reads) | Every frame the server sent, in words — `write holding 26 = 1` — and **which client received it** |
| `command.undelivered` | warn | A command nothing was subscribed to receive: it went nowhere |
| `station.message` | debug, info for state/acks | Every frame the station sent, in words, and whether it was a **reply** (with latency) or **unprompted** (with the interval since the last push) |
| `mqtt.refused` | warn / error | A publish the broker refused — see below |
| `mqtt.keepalive-timeout`, `mqtt.error` | warn | What aedes reported, attached to the session it ended |

The broker also remembers every station it has seen in `stations.json`, so a
freshly started broker knows whom to expect and starts the absence clock for
them.

## Who may do what

The broker accepts any connection: a P280 connects with no username and no
password, so there is nothing to recognise a station by but the client id it
chooses. What a connection may *publish* is another matter.

- **Only the server may command a station.** Publishing to any topic with
  `client/request` in it — `<MAC>/client/request/...`, and every variation on
  it — is refused to everyone else, and aedes closes the connection of whoever
  tried. Last wills are checked too — otherwise a client could connect with a
  will aimed at the command topic and drop its socket.
- **Not even the server may brick it.** Every command frame, from anyone, is
  checked against `commandRefusal` from `@kraftverk/protocol`: holding register
  68 is never set outside its permitted values, whether as a single write or
  inside a multi-register write, whatever the frame's CRC says. The server's own
  writes have already passed the whitelist; this is the last point every frame
  passes, including those from the raw-MODBUS diagnostics route.
- **The server proves itself** with username `kraftverk-server` and a random
  token in `server/data/broker/token`, created on first use by whichever side
  needs it first. Client ids starting `kraftverk-` are refused to anyone else,
  so nothing on the LAN can take over the server's session.
- **`$kraftverk/...` topics are the broker's.** Presence and the journal are
  published there. Nobody may publish to them, and only the server may
  subscribe: the journal names stations, their addresses and their MQTT
  usernames. A leading `$` already keeps them out of a `#` subscription; asking
  for them by name gets a refusal code, not a disconnect.
- **Any client id is accepted, up to 256 characters.** aedes turns away ids
  over 23 by default, which a station from another model could easily exceed —
  and a station refused at the door looks exactly like one that never tried.
- **The admin API** listens on `127.0.0.1:3883`. `/health` is open; everything
  else needs the token as a bearer header.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `MQTT_HOST` / `MQTT_PORT` | `0.0.0.0` / `1883` | Where the broker listens for stations |
| `BROKER_ADMIN_HOST` / `BROKER_ADMIN_PORT` | `127.0.0.1` / `3883` | The admin API. Docker sets the host to `0.0.0.0` and does not publish the port |
| `BROKER_HOST` | `127.0.0.1` | Where the **server** connects to the broker |
| `BROKER_ADMIN_URL` | `http://127.0.0.1:3883` | Where the **server** reaches the admin API |
| `BROKER_SPAWN` | on | `0` stops the server starting a broker — for when it is its own service |
| `KRAFTVERK_BROKER_DIR` | `server/data/broker` | Token, state, known stations and the journal |
| `KRAFTVERK_BROKER_TOKEN` | — | The server's secret, instead of the token file |
| `BROKER_LOG_LEVEL` | `info`; `error` when the server or the CLI starts it | Console verbosity: `debug`, `info`, `warn`, `error`, `off`. A started broker's console goes to `stdout.log`, which only needs to explain a crash. The journal file always gets everything |
| `BROKER_LOG_DAYS` | `14` | Days of journal files to keep |

## Files

| File | What |
| --- | --- |
| `server/data/broker/token` | The server's secret |
| `server/data/broker/broker.json` | The running broker's pid, build and addresses. Removed on a clean stop |
| `server/data/broker/stations.json` | Every station seen, and why each last left |
| `server/data/broker/logs/broker-*.jsonl` | The journal |
| `server/data/broker/logs/stdout.log` | The broker's own console, for a crash that happens before the journal opens |

## When the station does not come back

1. `npm run broker:status` — is the broker running and listening?
2. `npm run broker -- logs -n 100` — is there a `tcp.open` from the station's IP
   since it left? If **no**, the station is not even trying: it is the
   documented failure. Power-cycle it, or re-save the Local MQTT Broker setting
   in BrightEMS.
3. If there **are** `tcp.open`s but no `mqtt.connected`, the handshake is
   failing — the `tcp.close` entry says after how long and how many bytes.
4. If it connected but the app shows nothing, check it subscribed
   (`mqtt.subscribe`), and look for `command.undelivered`.
