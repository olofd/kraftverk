# Security model

kraftverk controls hardware: it writes to a power station's registers — one
wrong value destroys it — and it can switch mains power through a smart plug.
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
  entrance* a request came through. The web container has three — the home
  network's, the home network's through a reverse proxy on the same machine,
  and the internet's — and stamps every request `lan` or `public`, overwriting anything the client sent. The
  server believes that stamp only from the web container itself, which it
  recognises by address (`KRAFTVERK_TRUSTED_PROXIES`).
- **Directly** (development, or the server's own port on the LAN): trusted when
  the address is private *and* nothing says a proxy was involved. A request
  carrying `X-Forwarded-For`, `Forwarded`, `X-Real-IP` or the web container's
  stamp, from anything but the web container, came through a proxy the server
  does not know — and is not trusted.

Anything ambiguous is untrusted. Being wrong in that direction costs setting
the server up from home.

Two tripwires make a misconfigured reverse proxy fail safe:

- **A request addressed by a public name or a public address is never the home
  network**, however it arrived — through any entrance or directly. The
  home network reaches the server by a private address, a `.local` name or a
  single-label name; the internet reaches it by its DDNS name, or by the
  router's address. This catches a reverse proxy pointed at the wrong
  entrance, or straight at the server, and a port forwarded on the router by
  mistake — none of which add forwarding headers (`publicHost`,
  `assessTrust`).
- **The web container's home-network entrance stamps anything that has been
  through a proxy as `public`**: a request arriving with `X-Forwarded-For`,
  `Forwarded`, `X-Real-IP` or `X-Forwarded-Host` (`web/Caddyfile`).

The web container's entrance for a reverse proxy on the same machine that
serves the home network by names of its own (`8081`) is published on the
host's loopback only too: having been through a proxy is expected there, and
the stamp is `lan`. That proxy must forward only the home network's names to
it; a public name forwarded there anyway is still caught by the first
tripwire.

The web container's internet entrance is published on the host's loopback
only, so the internet reaches it through the host's reverse proxy and nowhere
else, and that proxy's `X-Forwarded-For` is what gives the client's address
for rate limits and the audit log. It is read from the right
(`trusted_proxies_strict`): a proxy appends the address it saw to whatever the
client sent, so the left-most entry is the client's own claim, and taking it
would let anyone choose the address their guesses are counted against.

## Sessions and passwords

| | |
| --- | --- |
| Passwords | argon2id (Bun's built-in). At least 12 characters. At most two hashes run at once, so a burst of attempts cannot exhaust a small server's memory |
| Sessions | 256-bit random tokens in an `HttpOnly`, `SameSite=Lax`, `Path=/api` cookie — `Secure` whenever the browser is on HTTPS. Stored only as a SHA-256 hash, so a copy of the database cannot be replayed as live sessions. 30 days, renewed with use |
| Changing a password | Needs the current one — and wrong guesses at it count like failed logins — and signs the account out everywhere else. An administrator resetting someone else's signs *them* out everywhere; your own is only ever changed with your current one |
| Managing accounts | Adding an account, removing one and setting someone else's password need your own password again, not just a session: a borrowed session — an unlocked phone, a copied cookie — must not be able to leave behind an account or a password it knows. Wrong confirmations count like failed logins |
| Guessing | Counted per client address (an IPv6 caller's whole /64) and per username. Five failures are free; then each locks for twice as long, from one minute to fifteen. A wrong username takes as long as a wrong password, and gets the same answer. The username count from the internet is kept apart from the one at home, so someone who knows your username cannot lock you out of your own server from outside |
| The last account | Cannot be deleted |
| Erasing everything | Needs an account *and* the reset passphrase — 16 characters or more — from a file on the server. Wrong passphrases are counted and slowed down like logins, on a count of their own. Keeps the accounts, so the server is never left waiting to be claimed |

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

**CORS.** The app the web container serves is same-origin, and the native app
sends no origin, so neither needs CORS. In production only the origins named
in `ALLOWED_ORIGINS` may make credentialed requests; in development the Expo
dev server on a private address is allowed too, on its own ports (8081,
19006). It used to be every private address on any port — and a browser
treats another port on the same host as the same site, so the session cookie
went along: any other web app on the NAS with a script-injection hole could
have used this server as you. `ALLOWED_ORIGINS=*` is refused: with sign-in it
would hand every website your session.

**Secrets from setup steps.** A setup step that finds a secret — fetching a
Tuya local key — gives the app a short-lived placeholder, not the value.
Saving turns the placeholder back into the secret on the server, where it is
stored encrypted with the connection it belongs to. No secret is ever sent to a
browser, including the one it just asked for. The one exception is by design: a
connection held by the app itself keeps its secrets in that app's own database,
and they never reach the server (DATA-MODEL.md §3, §4): sealed as a home of the
app's own seals its secrets — below — in a browser's worker or a phone's
process (`createFollower` in `@kraftverk/hub`). A browser page that is not
secure can hold none: it has no private file system, and no Web Bluetooth
either.

**Clickjacking, caching, sniffing.** API responses are `Cache-Control:
no-store`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` and
`Referrer-Policy: no-referrer`. Request bodies are capped at 1 MB.

**Script injection.** The app is served with a Content-Security-Policy that
allows scripts from its own origin only — the build has no inline script — and
connections to its own server only, so injected markup can neither run code
nor send anything elsewhere. The one addition is `'wasm-unsafe-eval'`, so a
browser that keeps a home of its own can run SQLite's WebAssembly build — from
its own origin, like every script. The internet entrance adds
`Strict-Transport-Security`. See `web/Caddyfile`.

**A browser's own home, and what it holds for a server.** A browser keeps its
home — or, with a server, what it holds for it — in its origin's private file
system, in a worker, on a secure page only. A connection's secrets are sealed
there with AES-256-GCM, under a key itself
sealed by a key the browser generated as non-extractable and keeps in
IndexedDB: the files hold only what is sealed. A phone keeps the same key in
its secure storage (`client/src/platform/`).

## The station itself

Unchanged by any of this, and applied to every caller:

- **Register 68 is never set outside its permitted values** — 0 bricks the
  station permanently. Enforced in the Sydpower protocol code for writes this
  code builds, and by `commandRefusal` for frames it merely carries: in the MQTT
  broker for every command (including the server's), and in the station's
  link for every frame it sends, whoever holds the connection — the server or
  the app. The station's raw-frame tool is off unless the holder was started
  with `ALLOW_RAW_FRAMES=1`, and an app never is.
  `commandRefusal` fails closed: it passes only reads, and writes it can read
  to the end — a function code it does not know, a write cut short, or a
  multi-register write whose count, byte count and data disagree is refused.
  A read-only holder sends only raw frames that are reads, and every write
  the tool refuses is recorded in the audit timeline.
- Only the server may publish commands on the broker; see
  [BROKER.md](BROKER.md#who-may-do-what).
- Physical actions go through the action gateway, which records *who* — the
  account, or the automation — in the audit timeline. So do the station's own
  ports and settings, adding, removing and linking devices, raw frames, and
  every change to a device's setup. Where the app holds a connection itself,
  the same rules run there and the audit entry is sent to the server.

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
- **Device types, protocols and transports are trusted code, not
  sandboxed.** They run in the server's own process (and device types and
  protocols in the app too), with everything that process can do: the network,
  the disk, each other's memory. A scoped HTTP client limits what a device
  type asks of it, not what it could do by calling `fetch` itself — as the
  Tuya plugin does today for its cloud. Every one is part of this repository
  (ARCHITECTURE.md §5). One from anyone else would need a process of its own
  first.
- **Anyone with a shell on the server** owns it, and everything on it.
