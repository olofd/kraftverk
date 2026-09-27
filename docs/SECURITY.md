# Security model

kraftverk controls hardware: it writes to a power station's registers — one
wrong value destroys it — and it can switch mains power through a grid relay.
This document is what stands between that and anyone who should not have it,
and it is written so each layer can be checked rather than taken on trust.

> **Short version.** Everyone signs in — at home too, for reads as well as
> writes. Every account is an administrator, for now. The first account can
> only be created from the home network. The station's own guards — the
> register whitelist, register 68 never set to 0 — apply to everyone.

---

## Who may use the API

One gate stands in front of every `/api` route (`server/src/auth/routes.ts`),
and it asks one question: is there a valid session? The only routes open
without one are the way in — `/auth/state`, `/auth/setup`, `/auth/login` and
`/auth/logout` — each of which touches nothing but its own session.
`/api/health` answers the server's own machine (the container healthcheck) and
signed-in sessions; not the network.

The home network gets no exemption. Devices belong to accounts, so every
request has to say whose view it wants, and an anonymous visitor — however
local — has no answer. Sessions last 30 days and renew as they are used, so a
browser in regular use stays signed in.

A fresh server with no accounts refuses everything but setup, from anywhere.

## Creating the first account

The first account can only be created from the **home network**, so a fresh
server that is already reachable from outside cannot be claimed by whoever
finds it first. After that, accounts are added from the app by a signed-in
account, or with the recovery CLI.

Deciding "home network" is the part that is easy to get wrong, so it is done
in one pure function, `assessTrust` in `server/src/auth/trust.ts`, and tested
against every spoofing attempt we could think of.

The tempting rule — "the caller's address is private" — is wrong behind a
reverse proxy: every request then arrives from the proxy, which is on the LAN,
and the whole internet looks like the living room. So:

- **Through the web container** (the normal way in), trust follows *which
  entrance* a request came through. The web container has two, and stamps
  every request `lan` or `public`, overwriting anything the client sent. The
  server believes that stamp only from the web container itself, which it
  recognises by address (`KRAFTVERK_TRUSTED_PROXIES`).
- **Directly** (development, or the server's own port on the LAN): trusted when
  the address is private *and* nothing says a proxy was involved. A request
  carrying `X-Forwarded-For`, `Forwarded`, `X-Real-IP` or the web container's
  stamp, from anything but the web container, came through a proxy the server
  does not know — and is not trusted.

Anything ambiguous is untrusted. Being wrong in that direction costs setting
the server up from home.

The web container — which serves the app and proxies `/api`, and is being
added alongside this — carries two tripwires of its own on the home-network
entrance: a request whose `Host` is a real domain name, or that already carries
proxy headers, is stamped `public` anyway. A reverse proxy pointed at the wrong
entrance by mistake then cannot create the first account from the internet.
Until it exists, only the direct rules above apply.

## Sessions and passwords

| | |
| --- | --- |
| Passwords | argon2id (Bun's built-in). At least 12 characters. At most two hashes run at once, so a burst of attempts cannot exhaust a small server's memory |
| Sessions | 256-bit random tokens in an `HttpOnly`, `SameSite=Lax`, `Path=/api` cookie — `Secure` whenever the browser is on HTTPS. Stored only as a SHA-256 hash, so a copy of the database cannot be replayed as live sessions. 30 days, renewed with use |
| Changing a password | Needs the current one — and wrong guesses at it count like failed logins — and signs the account out everywhere else. An administrator resetting someone else's signs *them* out everywhere |
| Guessing | Counted per client address (an IPv6 caller's whole /64) and per username. Five failures are free; then each locks for twice as long, from one minute to fifteen. A wrong username takes as long as a wrong password, and gets the same answer. The username count from the internet is kept apart from the one at home, so someone who knows your username cannot lock you out of your own server from outside |
| The last account | Cannot be deleted |
| Erasing everything | Needs an account *and* the reset passphrase from a file on the server. Keeps the accounts, so the server is never left waiting to be claimed |

## Attacks the browser makes possible

**Cross-site request forgery.** Before accounts existed, any website you
visited could switch the relay: a "simple" cross-origin `POST` with a
`text/plain` body needs no permission from the browser, the server parsed the
body as JSON anyway, and CORS only stopped the page *reading* the answer. Now
every request that changes anything must carry an `X-Kraftverk-Client` header.
A page on another site cannot add a custom header without the browser first
asking this server, and CORS refuses.

**DNS rebinding.** A page on `evil.example` can make its own name resolve to
your server's LAN address. The browser then treats requests to it as
same-origin — no CORS, custom headers allowed — and they arrive from your LAN
address. It cannot ride your session (cookies are kept by host name), but it can
act as the home network, which may create the first account on a fresh server.
The `Host` header gives it away: it still says `evil.example`. The
server answers only to IP addresses, `localhost`, `.local` names, single-label
names such as Docker service names, and names listed in
`KRAFTVERK_ALLOWED_HOSTS` — anything else gets `421` before any other code runs
(`server/src/auth/host.ts`).

**CORS.** Only loopback and private-range origins, plus any named in
`ALLOWED_ORIGINS`, may make credentialed requests. `ALLOWED_ORIGINS=*` is
refused: with sign-in it would hand every website your session.

**Clickjacking, caching, sniffing.** API responses are `Cache-Control:
no-store`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` and
`Referrer-Policy: no-referrer`. Request bodies are capped at 1 MB.

## The station itself

Unchanged by any of this, and applied to every caller:

- **Register 68 is never set outside its permitted values** — 0 bricks the
  station permanently. Enforced in the protocol package for writes this code
  builds, and by `commandRefusal` for frames it merely carries: in the MQTT
  broker for every command (including the server's), and on the raw-MODBUS
  diagnostics route, which is itself off unless `ALLOW_RAW_MODBUS=1`.
- Only the server may publish commands on the broker; see
  [BROKER.md](BROKER.md#who-may-do-what).
- Physical actions go through the action gateway, which records *who* — the
  account — in the audit timeline. So do the station's own ports and
  settings, linking and unlinking it, raw frames, and every extension's
  configuration and grants.

## Recovering access

If nobody can log in — every password forgotten — a shell on the server is the
proof of ownership:

```bash
npm run users -- list
npm run users -- password <name>      # generates one and shows it once
npm run users -- add <name>           # a new account, the same way
# In Docker:
docker compose exec kraftverk bun run server/src/auth/cli.ts password <name>
```

Passwords are never taken as command-line arguments, where shell history and
the process list would keep them: they are generated, or piped in with
`--stdin`.

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `KRAFTVERK_TRUSTED_PROXIES` | — | The web container, by name or address. Its entrance stamp is believed — for first-account setup — and nothing else's is |
| `KRAFTVERK_ALLOWED_HOSTS` | — | Names the server answers to besides addresses and local names — a public DDNS name, say |
| `ALLOWED_ORIGINS` | — | Extra browser origins. `*` is refused |

## What this does not protect against

Stated plainly, so nobody assumes otherwise:

- **Every account is an administrator**, for now: anyone you give an account
  can use and change everything, and manage accounts. Give one only to someone
  you would trust with the house. Homes with owners and members are the
  direction — see [ACCOUNTS.md](ACCOUNTS.md).
- **Traffic on the home network is plain HTTP.** A login made there crosses the
  LAN unencrypted, and anyone able to watch the LAN could take the session.
  From outside, HTTPS is terminated before the web container.
- **The MQTT broker accepts any connection** — a P280 connects with no
  username and no password, so there is nothing to check. What a connection
  may *publish* is restricted, but anything on the LAN can connect under the
  station's client id, push the real station off, and report whatever it
  likes in its place. Plain MQTT, unencrypted. Keep port 1883 off the internet.
- **Anyone with a shell on the server** owns it, and everything on it.
