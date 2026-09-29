# The HTTP API

Every endpoint the server has, and every setting it reads from its
environment. The typed client is `packages/api-client`; the shapes it speaks
are declared once, in `packages/api-contract`.

## Endpoints

Base URL: `http://<host>:3333/api` — or, in Docker, through the web container:
`http://<host>:8080/api`.

Every route passes one gate: a session cookie, reads and writes alike, from any
network. Only the sign-in routes are open, and `/health` answers the server's own
machine. Every request that changes anything must carry an `X-Kraftverk-Client`
header. See
[docs/SECURITY.md](SECURITY.md).

Everything is device-scoped: a route names the device it acts on. `:id` is an
opaque catalog id (`d-3db445e0a1b2`; older ones look like
`power-station:3db445e0`), so URL-encode it. A device's own permanent id — its
MAC, a Tuya device id — is `identity`, a separate field: it is how the same
device is recognised however it is found, and why removing one and adding it
again can bring its history back. Health is not a boolean: `health.status` is
one of `connected`, `connecting`, `offline`, `unconfigured` or `error`, and
always comes with a sentence in `health.detail`. Nothing here names a device
type: a type's own tools are its `advanced` actions.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Liveness — for the server's own machine (the container healthcheck) and signed-in sessions |
| `GET` | `/auth/state` | Who you are, whether this network is trusted, whether setup is due |
| `POST` | `/auth/setup` · `/auth/login` · `/auth/logout` | The first account (home network only), signing in and out |
| `POST` | `/auth/password` | Your own password; needs the current one |
| `GET` `POST` `DELETE` | `/users` · `/users/:id` · `/users/:id/password` | Accounts |
| `GET` | `/version` | Name, version, runtime, uptime; simulator or not, transports, read-only |
| `GET` | `/device-types` | What can be added: categories, installed types, and whether this server can hold each method |
| `POST` | `/setup` | Start adding a device over a method this server will hold; the steps follow |
| `GET` `PATCH` `DELETE` | `/setup/:id` | The draft; values from a form step (secrets stay here); discard it |
| `GET` | `/setup/:id/sightings` | What the transport sees that this type's protocol recognises, marked when already yours |
| `POST` | `/setup/:id/choose` · `/steps/:step/actions/:action` · `/steps/:step/discover` | Choose the device; run a step's helper ("fetch the key") on the server |
| `POST` | `/setup/:id/check` · `/setup/:id/save` | Read it once — new, yours, yours before, another model — then save it all in one go |
| `POST` | `/setup/app` | A connection this app will hold: what it learnt reading the device itself, never a secret |
| `GET` | `/devices` · `/devices/removed` | The devices you have, each with its description (parts, attributes, events), information, live readings, health, connections and links; removed ones, with their history |
| `GET` `PATCH` `DELETE` | `/devices/:id` | Read, rename, or remove — keeping its history |
| `POST` | `/devices/:id/delete-history` | Delete a removed device and everything it recorded; its name, typed, confirms it |
| `PATCH` | `/devices/:id/attributes` | Change what a device remembers — the attributes its description says can be written — through the action gateway; a refusal says `needsConfirmation` when a person only has to confirm |
| `POST` | `/devices/:id/parts/:part/commands/:capability/:command` | Every command, to one part of a device, with typed `args` — through the action gateway; a refusal says `needsConfirmation` when a person only has to confirm |
| `GET` | `/devices/:id/events` | What the device said happened, newest first |
| `GET` `POST` | `/devices/:id/advanced/:name` | A device type's own tools: register dump, snapshot, scan, raw frame. Reads are GETs; writes are refused while read-only and audited |
| `GET` | `/devices/:id/history` | One measurement over time, thinned for a chart |
| `POST` `DELETE` | `/devices/:id/connections/:connection` (`/prefer`) | Prefer one way to reach it, or remove one — not the last |
| `PUT` | `/devices/:id/connections/:connection/secrets` | Replace a server-held connection's secrets, such as a plug's new local key |
| `POST` `DELETE` | `/links` · `/links/:id` | Facts about the house: this plug feeds that station |
| `GET` `POST` `DELETE` | `/clients` · `/clients/:id` | The phones and browsers that hold connections |
| `POST` | `/devices/:id/readings` · `/clients/:id/audit` | What an app sends for a connection it holds |
| `GET` `PUT` | `/devices/:id/store` · `/devices/:id/store/:key` | A device's own store, for a session an app runs |
| `GET` | `/transports` · `/transports/:id/diagnostics/:name` | What this server reaches devices over, and each transport's diagnostics — the broker, its journal, its traffic |
| `GET` | `/found` | What the transports see that nothing you have is reached by |
| `GET` | `/diagnostics/log` | The server's own recent log (`?level=warn`, `?limit=`), and where its daily files are |
| `GET` | `/audit` | The timeline: intents, commands, verification outcomes |

## Environment

| Variable | Flag | Default | Meaning |
| --- | --- | --- | --- |
| `STATION_DRIVER` | `--driver=` | `sim` | `sim` reaches no hardware; `device` means Bluetooth and MQTT; or a list, `mqtt`, `ble,mqtt`. Every hardware mode also has the home network (`lan`) and `https` |
| `KRAFTVERK_TRANSPORTS` | — | — | Names the transports outright instead: `mqtt,lan,https` |
| `READ_ONLY` | `--read-only` | on for hardware modes | Refuse every write |
| `PORT` / `HOST` | — | `3333` / `0.0.0.0` | HTTP API |
| `MQTT_PORT` / `MQTT_HOST` | — | `1883` / `0.0.0.0` | Where the MQTT broker listens for stations |
| `BROKER_HOST` / `BROKER_ADMIN_URL` | — | `127.0.0.1` / `http://127.0.0.1:3883` | Where the server reaches the broker |
| `BROKER_SPAWN` | — | on | `0` stops the server starting a broker, for when it runs as its own service. The rest of the broker's settings are in [docs/BROKER.md](BROKER.md#environment) |
| `ALLOWED_ORIGINS` | — | — | Browser origins allowed to call the API with your session, comma-separated. Not needed for the web container (same origin) or the native app; in development the Expo dev server on a private address is allowed on its own. `*` is refused |
| `KRAFTVERK_ALLOWED_HOSTS` | — | — | Names the server answers to besides addresses and local names, such as a DDNS name. Others get `421` (DNS-rebinding defence) |
| `KRAFTVERK_TRUSTED_PROXIES` | — | — | The web container, whose home-network/public entrance stamp is believed. See [docs/SECURITY.md](SECURITY.md) |
| `ALLOW_RAW_FRAMES` (or `ALLOW_RAW_MODBUS`) | — | — | `1` lets a device type's raw-frame tool send frames nobody has described. The protocol's guard still applies |
| `KRAFTVERK_DB` | — | `server/data/kraftverk.db` | Where the database lives. **Required under `NODE_ENV=test`** — the server refuses to open the default file from a test run |
| `KRAFTVERK_RESET_SECRET_FILE` | — | `server/data/reset-secret` | A passphrase of 16+ characters here lets the app empty the database from **App settings → Danger zone**. No file means the route does not exist; the app shows how to enable it rather than a dead button. Gitignored |
| `KRAFTVERK_SECRET_KEY` | — | — | Passphrase for AES-256-GCM secrets, such as a plug's local key. Without it they are stored as given, and the UI says so |
