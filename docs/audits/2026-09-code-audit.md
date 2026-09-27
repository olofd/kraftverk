# kraftverk: audit

**Scope:** the whole repository at `1871984` on `claude/quirky-gates-vhtjpe`. That covers the server (auth, API, connections, gateway, plugins, broker, transports, storage), the shared packages (protocol, plugin SDK, API client, P280 device, Tuya plugin), the client app, and the deployment files (Dockerfile, compose, Caddy, CI).

**How:** I read the code by hand and checked it against the project's own docs (SECURITY, ACCOUNTS, BROKER). I ran the existing checks: **283/283 tests pass** and the **typecheck is clean**. For the most serious findings I wrote small throwaway tests against the real classes to confirm the behaviour, then deleted them. Nothing in the repo was changed.

**Evidence labels:**
- **Reproduced**: I ran it and saw it happen.
- **Code**: follows directly from the code as written.
- **Likely**: depends on third-party behaviour I didn't run.

---

## Summary

The codebase is careful. It has a written threat model, argon2id with a cap on concurrent hashing, hashed session tokens, a DNS-rebinding guard, a CSRF header, a register-68 guard at three layers, and writes pinned to the link they were meant for. Most of what's below is in the gaps between those protections.

The most important problem runs through several findings: **the station model makes up values when it has no data.** `buildStatus`/`buildSettings` fill in `0 %`, `false`, `1800 W` and "updated now" rather than *unknown*. The relay gateway, the port switch, the sampler and the settings screen then trust those made-up values. Fixing that at the source (see A2) removes H1, H2, R4 and R5 together.

| # | Severity | Finding | Evidence |
|---|---|---|---|
| H1 | **High** | The grid relay reports "verified by the plug and the station" when the station has sent no data at all | Reproduced |
| H2 | **High** | Port switches write blind to a register that toggles, so "on" can turn AC off | Reproduced |
| H3 | **High** | Bun closes every request after 10 s: relay switching and setup actions fail on the client even though they ran | Reproduced |
| H4 | **High** | The poll queue grows without limit while a station is silent, so writes run long after the user gave up ("ghost writes") | Code |
| S1 | Medium | The current-password check on a password change can be skipped through `/api/users/<own id>/password` | Code |
| S2 | Medium | The reset passphrase can be guessed without limit by any signed-in session | Code |
| S3 | Medium | A port-forwarded `:8080` reached by public IP counts as the home network, so a fresh server can be claimed from the internet | Code |
| S4 | Medium | Caddy takes the client IP from the left-most `X-Forwarded-For`, so per-IP login limits can be bypassed | Likely |
| S5 | Medium | Credentialed CORS for every private-IP or `.local` origin: any other web app on the same NAS host can drive the API | Code |
| S6 | Medium | Spoofed MQTT telemetry (retained, too) feeds the relay verification and the port-toggle decisions | Code |
| R1 | Medium | Two overlapping `sync()` calls build two drivers for one station, and a device deleted mid-open keeps a live session | Reproduced |
| R2 | Medium | A rebind that fails leaves the device on a closed link until restart | Code |
| R4 | Medium | History records 0 % battery and 0 W for a station that isn't answering | Code |
| R5 | Medium | The settings screen shows invented defaults as the station's real settings | Code |
| R9 | Medium | `POST/PATCH /devices` accept any driver, type or config, which can create a hidden hardware session | Code |
| A1 | Medium | `server/src/index.ts` is a 1,700-line script that can't be tested, which is why the route bugs went unnoticed | Code |
| P1 | Medium | The broker writes every frame to disk synchronously, and keeps it for 14 days | Code |
| … | Low/Info | 25 more below | |

**Suggested order:** H3 (a one-line fix) → A2 (unknown means unknown, which fixes H1, H2, R4 and R5) → H4 → R1/R2 → S1–S5 → A1 (so the route fixes get tests) → the rest.

---

## 1. Hardware safety and correctness

### H1 — The relay gateway "verifies" mains removal against a station it has never heard from · High · Reproduced

`server/src/actions/gateway.ts:202`, `:272` · `packages/protocol/src/station.ts:114`

The gateway's second proof is that the station's AC input agrees, and before that it refuses to act on data older than 60 s. But `buildStatus` sets `lastUpdated = (lastSeen ?? new Date())`. A station that has sent nothing (asleep, out of range, just rebound, bus reconnecting) therefore always looks fresh. It also has `gridConnected = false` by default.

What I ran: a `StationClient` on a link that never answers, and an `ActionGateway` asked to switch mains **off**:

```
status.lastUpdated 2026-09-27T10:43:58Z  link offline  =>
{ outcome: "verified", detail: "Grid AC removed, confirmed by the plug and the station", stationAgreed: true }
```

This is exactly the false "verified" that the gateway's own comments say it exists to prevent. `#stationAgrees` also reads the *cached* status and never asks for a frame that arrived after the command was sent.

**Fix:** `lastUpdated: null` and `gridConnected: null` until telemetry exists. The gateway should require `link.state === 'connected'`, and a telemetry frame whose timestamp is after `setRelay` returned, before it counts the station as agreeing.

### H2 — Port switching writes blind to a toggling register · High · Reproduced

`packages/protocol/src/client.ts:384`

Holding registers 25 (DC) and 26 (AC) *toggle* on any write, which the README documents. `setPort` decides whether to write by comparing against the **cached** port state. That cache is `false` when there is no telemetry, and up to one poll (5 s) old otherwise. Measured on a station that hasn't answered:

```
setPort('ac', false) -> 0 frames sent, returns success      (AC may still be on)
setPort('ac', true)  -> 1106001a00015d6b sent                  (if AC was already on, this turns it OFF)
```

The same problem shows up in three other ways:
- The physical button pressed since the last poll.
- A double tap: the check happens outside the write queue, so two requests both see "off" and both write, which toggles twice.
- A spoofed MQTT frame (S6).

The README warns about switching ports with medical or heating equipment attached. This is the path where that goes wrong. It also affects the app's direct Bluetooth link (`DirectLinkProvider.tsx:766`), because it uses the same class.

**Fix:**
- Inside the queued task, read holding registers fresh immediately before writing.
- Refuse the switch if there is no fresh reading.
- Poll afterwards and report a mismatch instead of success.

### H3 — Bun closes requests after 10 s, but the server's long operations take up to 90 s · High · Reproduced

`server/src/index.ts:1709` (`export default { port, hostname, fetch }`, no `idleTimeout`)

I checked this with a handler that takes 14 s on Bun 1.3.11. curl got its connection closed at about 10 s, and Bun logged `request timed out after 10 seconds. Pass idleTimeout to configure.` The following routes can take longer than that:

| Route | Worst case |
|---|---|
| `POST /grid/relay`, `POST /devices/:id/control/:relay` | plugin calls + up to 30 s of verification |
| `POST /plugins/:id/setup/:action` | up to 90 s (network scan, cloud) |
| `/diagnostics/*` on BLE | 8 s per read, behind the queue (H4) |

The client allows 45 s or 95 s (`api.ts`), but the connection is gone at 10 s. The user sees a network error while the relay **did** switch and the audit log records it. A natural retry then gets refused by the dwell time, or toggles again.

**Fix:** `export default { …, idleTimeout: 120 }` (Bun allows up to 255). Longer term, return `202` with an operation id for anything physical.

### H4 — The poll queue grows without limit while a station is silent, and writes run late · High · Code

`packages/protocol/src/client.ts:207`, `:285` · `server/src/transport/ble.ts:440`

`setInterval(#poll, 5000)` fires whether or not the last poll has finished. On BLE a request that gets no answer takes 8 s to time out, so while a connected station is silent, each 5 s adds 8 s of work to the serial queue. On MQTT the station needs to be connected but not answering; the 5 s timeout then equals the interval and the queue stays full.

A port switch or settings write waits behind all of that. HTTP gives up at 10 s (H3), and then the write is sent to the hardware tens of seconds or minutes later, after the user has moved on.

**Fix:** skip a poll while one is in flight. Give each write a deadline and drop it with an error if it hasn't been sent by then. Let writes go ahead of queued polls.

### R4 — History records made-up zeros for a station that isn't answering · Medium · Code

`server/src/devices/registry.ts:234`, via `buildStatus`

`#stationView` always returns `p280Readings(status)`. With no telemetry that is `soc 0`, `inputWatts 0`, … and the sampler writes those every minute. So a bound station that is asleep produces a chart showing the battery at 0 %. A station that has gone offline produces a flat line at its last values. The sampler's own comment says "a gap is honest, a zero is a lie", and this breaks that.

**Fix:** null readings unless `link.state === 'connected'` and telemetry exists (A2).

### R5 — Settings shown before the station has answered are invented · Medium · Code

`packages/protocol/src/station.ts` (`buildSettings`) · `packages/devices/aferiy-p280/ui/settings.tsx:112`

`/p280/state` always returns a settings object. With no holding registers read, it is charge limit 100 %, floor 0 %, 1800 W, sleep 480 min. The panel only checks `if (!settings)`, so these defaults appear as the station's real configuration.

**Fix:** return `settings: null` until the first holding read, and show "not read yet".

### R6 — MQTT pairs a request with any frame on the same channel · Low · Code

`server/src/mqtt/bus.ts:181`

`request` resolves with the next frame on `data` for that MAC, whatever its function code. A write echo (fn 0x06) or an exception response can satisfy a holding read. `BleLink.request` already filters by function code, so the two transports behave differently.

**Fix:** match `frame.fn` the way BLE does.

### R8 — One register baseline shared by every station · Low · Code

`server/src/index.ts:821`

`baseline` is a single global. Taking a snapshot on station A and dumping registers on station B diffs B against A. That produces convincing wrong answers in the one workflow meant to find register differences between models.

**Fix:** key it by `deviceId`, both in memory and in the file.

---

## 2. Security

### S1 — The "needs the current password" rule can be bypassed · Medium · Code

`server/src/auth/routes.ts:312`

`/auth/password` requires the current password, is rate-limited, and says a borrowed session must not be enough. But `POST /api/users/<your own id>/password` sets your own password with no current password, and even keeps your session. Every account is an administrator, so a borrowed session can also simply create a new account.

**Fix:** decide what the protection is for. Either require re-authentication for *all* account administration (password resets, adding and removing users), or remove the promise from SECURITY.md. At minimum, refuse `target.id === actor.id` on the admin route.

### S2 — The reset passphrase can be guessed without limit · Medium · Code

`server/src/index.ts:1245` · `server/src/admin/reset.ts:47`

This is the most destructive route in the API, and a wrong passphrase costs nothing: no limiter, no delay. The minimum length is 8. `secretMatches` also returns early on a length mismatch, which leaks the length. That contradicts its own comment ("compare a fixed-size digest"), although the leak is trivial.

**Fix:** put the route behind `LoginLimiter`, keyed by account and IP, and compare SHA-256 digests. Consider requiring 16 or more characters.

### S3 — Requests addressed by a public IP count as home · Medium · Code

`server/src/auth/host.ts:70` (`isLocalName`: `if (isIP(host)) return true`) · `server/src/auth/trust.ts`

The "addressed by a public name is never home" tripwire only catches DNS names. Suppose someone port-forwards `:8080` on the router, which is easy to do by mistake. Internet scanners send `Host: <public IP>` with no forwarding headers. The `:8080` entrance stamps that request `lan`, the tripwire doesn't fire, and a **fresh server's first account can be created from the internet**. It also moves internet login attempts into the `user@home` limiter bucket, which the design deliberately keeps separate.

**Fix:** an IP literal only counts as local when `isPrivate(ip)`. Treat a public IP in `Host` the same as a public name.

### S4 — The client IP can be spoofed through `X-Forwarded-For` · Medium · Likely

`web/Caddyfile:23`

With `trusted_proxies static private_ranges` and no `trusted_proxies_strict`, Caddy takes the **left-most** `X-Forwarded-For` entry. DSM's proxy appends the real address to whatever the client sent, so the client chooses the IP the server sees. The consequences:
- The per-IP login limit is bypassed by rotating the header.
- Audit IPs can be forged.
- Every attempt costs an argon2 hash (two slots, then queued) plus an audit row, so it becomes a cheap CPU and disk DoS.

**Fix:** add `trusted_proxies_strict` to the `:8090` server options. Separately, rate-limit or aggregate the `auth.login-failed` audit rows.

### S5 — Credentialed CORS is wider than it needs to be · Medium · Code

`server/src/index.ts:460` (`PRIVATE_HOST`)

Any `http(s)://<private IP or *.local>` origin gets `Access-Control-Allow-Credentials`. Browsers treat the same host on different ports as the *same site*, so a `SameSite=Lax` cookie is sent. Any other web app on the NAS (DSM, Plex, Home Assistant, a router UI on the same box) that has an XSS can therefore act as the signed-in user and **read the answers**.

The production app is same-origin behind the web container and needs no CORS at all.

**Fix:** allow CORS only for `ALLOWED_ORIGINS`, plus the Metro dev origin in development.

### S6 — Spoofed station telemetry drives safety decisions · Medium · Code

`server/src/broker/policy.ts`

SECURITY.md says a LAN client can impersonate the station. What it doesn't draw out is the effect: any client can publish to `<MAC>/device/response/…`, **retained** too. The server then uses that data for:
- relay verification (H1: fake "AC present or absent"),
- port-toggle decisions (H2: fake "AC off" makes the server write, which toggles AC off),
- auto-binding (every MQTT publisher is `likelyStation: true`, so an unbound saved station takes the first MAC that speaks),
- unbounded `discovered` and station maps.

**Fix:**
- Accept response topics only from the connection that currently holds that station, by client id or remote address.
- Refuse `retain` on response topics.
- Cap the discovered entries.
- Stop auto-binding over MQTT.

### S7 — The plugin sandbox is advisory · Low · Code

`server/src/plugins/host.ts:456` · `packages/plugins/tuya-local-grid-relay/src/cloud.ts:113`

`allowedHosts` applies only to `context.http`. The Tuya plugin calls the global `fetch` directly, and plugins run in-process with full Node access (`dgram`, `net`, `fs`). `context.http` also follows redirects to hosts that aren't allowed.

That's fine for first-party code, but the docs shouldn't describe it as isolation, and it would need process isolation before any third-party plugin.

### S8 — Plugin secrets come back to the browser · Low · Code

`packages/plugins/tuya-local-grid-relay/src/setup.ts:148`

`fetchKeys` returns the Tuya `localKey` in its result so the form can be filled. The API otherwise promises secrets are never returned. The server could store the key directly and return only "set".

### S9 — The committed `.claude/settings.json` pre-approves arbitrary execution · Low/Info

`Bash(node -e:*)`, `Bash(find:*)` (which covers `-exec` and `-delete`), `Bash(for *)`, `Bash(sed:*)` (which covers `sed -i`) and `WebFetch(*)` together let an agent session run anything without a prompt. Combined with fetched web content, that is a prompt-injection path.

**Fix:** narrow these rules, or move them to a local, uncommitted settings file.

### Also worth noting (Info)

- `/auth/state` tells unauthenticated callers the trust `reason`, including their socket IP.
- There is no way to clear a stored plugin secret: empty strings are skipped.
- Secrets are stored in plain text unless `KRAFTVERK_SECRET_KEY` is set (documented).

---

## 3. Reliability and concurrency

### R1 — Overlapping `sync()` calls double-open a station, and a deleted device keeps its session · Medium · Reproduced

`server/src/connections/manager.ts:201–256`

`open()` stores the session only after `await #hardware()` and `await driver.start()`. `sync()` is called from `POST /devices`, `DELETE /devices`, the legacy import and the reset. What I measured:

```
two concurrent syncs, one saved station  -> drivers built and started: 2, sessions held: 1   (one driver polls forever, never stopped)
device forgotten while its session opens -> sessions after the forget: 1                    (zombie session for a deleted device)
```

On hardware, the leaked driver keeps a link and a discovery watcher. A station accepts only one connection.

**Fix:** serialise `sync` with a promise mutex, or record a pending-open entry synchronously and have `close()` cancel it.

### R2 — A failed rebind strands the device · Medium · Code

`server/src/connections/manager.ts:390`

`bind()` closes the old link *before* opening the new one. If `host.open(station)` throws, `#bound` is rolled back but the driver still points at the closed link. The device stays offline until the server restarts.

**Fix:** open the new link first, then swap, then close the old one. Or reopen the previous link on failure.

### R3 — A failed `open()` leaks its link and watcher · Low · Code

`manager.ts:254`

If `driver.start()` throws, the link is already open and the watcher already registered, but no session is stored, so `close()` can never release them.

### R7 — Invalid plugin configuration returns 500 · Low · Code

`server/src/plugins/host.ts` (`ConfigError`) · `server/src/index.ts:1682`

`app.onError` handles HTTPException, ZodError, UnsafeWriteError and ReadOnlyError, but not `ConfigError`. A mistyped field in Extensions therefore shows "Internal server error" instead of which field is wrong.

### R9 — Device records aren't validated · Medium · Code

`server/src/index.ts:1384`, `:1433` · `manager.ts:201`

- `driver` is any string, `model` is any string, and `config` is any record.
- `ConnectionManager.sync` opens hardware sessions by `type` alone. So `{type:'power-station', driver:'x'}` gets a real hardware session that auto-binds and polls a station, while the registry shows it as "Driver x is not installed".
- `PATCH /devices/:id` with `config.boundId`/`transport` rewrites the binding without going through `bind()` or its claim check, and doesn't take effect until restart.

**Fix:** validate `(type, driver)` pairs and `model ∈ STATION_MODELS`, and don't let PATCH set `boundId`/`transport`.

### R10 — Relay controls ignore which device was tapped · Low · Code

`server/src/index.ts:1663`

A `gridRelay.switch` control on *any* device calls the gateway, and the gateway uses the *active provider*. With two relay plugins, the switch on plug A's card flips plug B.

### R11 — Path parameters are decoded twice · Low · Code

`server/src/index.ts`, all `decodeURIComponent(c.req.param(...))`

Hono has already decoded the parameter, so an id containing `%` throws `URIError` and returns 500.

### R12 — Timers leak in plugin calls and setup actions · Low · Code

`server/src/plugins/host.ts:49`

`withTimeout` and the setup-action race never clear their timers. A plugin whose `start()` times out is marked failed but keeps running.

### R13 — A database reset leaves plugins running on configuration that no longer exists · Low · Code

The reset stops the sampler and connections but not the plugin host. The plugins show "healthy" and keep polling with configuration from before the wipe.

---

## 4. Performance

### P1 — The broker writes every frame to disk synchronously · Medium · Code

`server/src/broker/journal.ts:155`

Every journal entry, including debug-level polls, telemetry, pings and hex payloads, is written with `appendFileSync`, on the broker's event loop, and kept for 14 days.

At a 5 s poll that's about four frames per 5 s per station, or roughly 70k lines a day. A rough guess is 50 MB a day per station, which adds up to hundreds of MB over 14 days. That is continuous write load on an SD card or NAS disk.

**Fix:** don't persist debug entries by default (the in-memory ring already serves `/traffic`), or buffer them and write asynchronously.

### P2 — The sample table has a duplicate index · Low · Code

`server/src/history/db.ts:178`

`sample_lookup (device_id, key, at)` duplicates the primary key, so every sample updates two identical B-trees. Drop it in a new migration.

### P3 — History charts are thinned in JavaScript, not SQL · Low · Code

`server/src/history/sampler.ts:104`

The comment says thinning happens in SQL, but every row in the window (up to about 20k per key) is loaded and then averaged in JavaScript. Bucketing with `GROUP BY` on a time bucket would fix it.

### P4 — Client polling overlaps and leaks · Low · Code

`client/src/features/devices/connection.tsx:142` · `client/src/state/DevicesProvider.tsx:201`

- There is a 2 s interval against a 6 s axios timeout with no in-flight guard. Requests overlap, and a late response can overwrite newer state.
- `load(signal).then(start)` runs *after* cleanup when you navigate away before the first response. That leaves an interval that is never cleared, one per quick navigation.
- Every 401 triggers `/auth/state`, so a burst of failing polls produces a burst of refreshes.

### P5 — The audit table is never trimmed · Low · Code

Failed logins, plugin `emit`s and every setting change add rows forever. Combined with S4, an attacker can grow it without limit.

---

## 5. Architecture

### A1 — `server/src/index.ts` can't be tested · Medium

The file is 1,709 lines of environment parsing, top-level `await` side effects (discovering plugins, starting radios and the broker), about 45 routes, and policy. Importing it starts hardware, so none of its routes has an HTTP test.

Almost every route-level bug above lives in that file: S1, S2, R7, R8, R9, R10, R11.

**Fix:** a `createApp(deps)` factory plus route modules (`routes/devices.ts`, `routes/diagnostics.ts`, …), with tests using Hono's `app.request()` against a simulator and an in-memory database. The existing tests show this pattern already works for the gateway and the manager.

### A2 — "Unknown" isn't part of the station model · Medium

This is the root cause of H1, H2, R4 and R5. `StationStatus` and `StationSettings` are all non-null, so the decoders invent values and every consumer trusts them.

**Fix:** make `StationStatus.telemetry` optional, or make the fields nullable, and let the compiler find every place that has to decide what "unknown" means. That's the same technique the codebase already uses for `SavedDeviceId` and `StationId`.

### A3 — Two device APIs in parallel

There are P280-specific routes (`/p280/state`, `/p280/settings`, `/diagnostics?deviceId=`) and generic ones (`/devices/:id/settings`, `/control`). They are two write paths to the same registers, with different audit kinds and different validation. The diagnostics routes still identify the device with a query string. Pick one and retire the other.

### A4 — Safety state kept in process memory

The gateway's `#lastSwitchAt`/`#everSwitched` are shared by every relay and lost on restart. The register baseline is global (R8). `db()` is a module-level singleton, which is the reason the test suite needed the "never open the real database" tripwire.

### A5 — Dead client API

`fetchStatus`, `fetchSettings`, `patchSettings`, `setPort` and `setGridConnected` (`packages/api-client/src/api.ts:158` onwards) call routes the server removed, so they would get 404s. Nothing calls them. Delete them.

### A6 — Plugins run in-process

See S7. It's fine today. Write down that third-party plugins would need a process boundary.

---

## 6. User experience

- **Actions that worked show as failures (H3).** Relay and setup actions show a network error at 10 s. Retrying then hits the dwell refusal, or toggles again.
- **Numbers that aren't real (R4, R5).** The battery shows 0 % in history during outages, and made-up settings appear before the first read.
- **"Off" that doesn't turn anything off (H2).** When the state is unknown, "off" does nothing and returns success, so the switch shows off while AC is still on.
- **An unreachable server looks like being signed in.** `AuthProvider.tsx:156` has `allowed: … || unknown`, so an unreachable server shows the full UI full of errors instead of a clear offline or sign-in screen.
- **The server list and the web build contradict each other.** The web container's CSP is `connect-src 'self'`, but App settings still lets you add other servers, and requests to them are silently blocked. Hide the list in same-origin builds, or explain why.
- **A bare hostname becomes plain HTTP on the API port.** `servers.ts:49` turns a bare host into `http://<host>:3333/api` even for a public DDNS name, which sends passwords in plain text. Default to `https://` with no port when the name isn't local.
- **Plugin configuration errors show as "Internal server error" (R7).**
- **Outdated screenshots.** The README screenshots predate the device-first layout (already acknowledged in the README).

---

## 7. What's already done well

- The threat model is written down and each layer can be checked (SECURITY.md, ACCOUNTS.md, BROKER.md).
- Passwords use argon2id with a cap on concurrent hashing. Usernames get a decoy hash so response time doesn't reveal which exist. Session tokens are stored only as hashes. There are separate home and internet lockout buckets.
- The DNS-rebinding host guard, the forgery header, the body limit and the no-store/no-frame headers.
- The register-68 guard sits at the protocol, the broker and the raw route. Writes are pinned to their link so they refuse to follow a rebind.
- The gateway serialises calls, records intent before acting and records the outcome after.
- The containers run as non-root, CI actions are pinned by SHA, and the secret-bearing paths are in `.dockerignore`.
- 283 passing tests, including attack-style tests for trust and the broker.

---

## Appendix: checks run

| Check | Result |
|---|---|
| `bun test` (repo root, `NODE_ENV=test`) | 283 pass, 0 fail, 19 files |
| `npm run typecheck` (all workspaces) | clean |
| Probe: gateway with a silent station | `outcome: "verified"` (H1) |
| Probe: `setPort` with no telemetry | off = 0 frames and success, on = `1106001a00015d6b` (H2) |
| Probe: 14 s handler on `Bun.serve` defaults | connection closed at about 10 s, Bun warns about `idleTimeout` (H3) |
| Probe: concurrent `sync()` / forget during open | 2 drivers for 1 station; zombie session (R1) |

The probe files were temporary and have been deleted. The working tree is unchanged.
