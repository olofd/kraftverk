#!/usr/bin/env bash
#
# Attacks a running kraftverk the way someone on the internet would, and uses it
# the way someone at home would. Run against a *fresh* stack: it creates the
# first account.
#
#   LAN_URL      the web container's home-network entrance   (default http://127.0.0.1:8080)
#   PUBLIC_URL   its internet entrance                        (default http://127.0.0.1:8090)
#   PUBLIC_HOST  a public name the server is configured to answer to
#                (KRAFTVERK_ALLOWED_HOSTS)                    (default kraftverk.example.test)
#
# Exits non-zero on the first thing that is not as it should be.

set -euo pipefail

LAN_URL=${LAN_URL:-http://127.0.0.1:8080}
PUBLIC_URL=${PUBLIC_URL:-http://127.0.0.1:8090}
PUBLIC_HOST=${PUBLIC_HOST:-kraftverk.example.test}
CLIENT='X-Kraftverk-Client: smoke'

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

passed=0
pass() { passed=$((passed + 1)); printf '  ok  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1" >&2; [ -f "$work/body" ] && { printf '      body: ' >&2; head -c 400 "$work/body" >&2; printf '\n' >&2; }; exit 1; }

# request <method> <url> [curl args...] — sets $status; body in $work/body, headers in $work/headers.
request() {
  local method=$1 url=$2
  shift 2
  status=$(curl -sS -o "$work/body" -D "$work/headers" -w '%{http_code}' -X "$method" "$@" "$url")
}
body_has() { grep -q -- "$1" "$work/body"; }
header_has() { grep -qi -- "$1" "$work/headers"; }
expect_status() { [ "$status" = "$1" ] || fail "$2 — expected $1, got $status"; pass "$2"; }

echo "The app"
request GET "$LAN_URL/"
expect_status 200 'the app is served'
body_has '<div id="root">' || fail 'the page is the app'
header_has "content-security-policy: default-src 'self'" || fail 'the page carries a content security policy'
pass 'with a content security policy'
request GET "$LAN_URL/device/some-device/settings"
expect_status 200 'deep links fall back to the app'
body_has '<div id="root">' || fail 'a deep link serves the app'

echo "A fresh server, from the internet"
request GET "$PUBLIC_URL/api/auth/state" -H "Host: $PUBLIC_HOST"
expect_status 200 'the sign-in state answers'
body_has '"setupRequired":true' || fail 'a fresh server says it needs setting up'
body_has '"canSetup":false' || fail 'but not from the internet'
pass 'and says it cannot be set up from here'
header_has 'strict-transport-security' || fail 'the internet entrance sends HSTS'
pass 'the internet entrance sends HSTS'
request POST "$PUBLIC_URL/api/auth/setup" -H "Host: $PUBLIC_HOST" -H "$CLIENT" -H 'Content-Type: application/json' \
  --data '{"username":"mallory","password":"correct horse battery staple"}'
expect_status 403 'the first account cannot be created from the internet'
request POST "$PUBLIC_URL/api/auth/setup" -H "Host: $PUBLIC_HOST" -H "$CLIENT" -H 'X-Kraftverk-Exposure: lan' \
  -H 'Content-Type: application/json' --data '{"username":"mallory","password":"correct horse battery staple"}'
expect_status 403 '…not even by claiming to be the home-network entrance'
request GET "$PUBLIC_URL/api/devices" -H "Host: $PUBLIC_HOST"
expect_status 401 'devices need a login'
request GET "$PUBLIC_URL/api/health" -H "Host: $PUBLIC_HOST"
expect_status 401 'the health check is not for the internet'

echo "Tripwires on the home-network entrance"
request GET "$LAN_URL/api/auth/state" -H 'X-Forwarded-For: 203.0.113.50'
body_has '"canSetup":false' || fail 'a request that came through a proxy is not the home network'
pass 'a request that came through a proxy is not the home network'
request GET "$LAN_URL/api/auth/state" -H "Host: $PUBLIC_HOST"
body_has '"canSetup":false' || fail 'a request addressed by the public name is not the home network'
pass 'a request addressed by the public name is not the home network'
request GET "$LAN_URL/api/auth/state" -H 'Host: 198.51.100.7:8080'
body_has '"canSetup":false' || fail 'a request addressed by a public address is not the home network (a port forwarded on the router)'
pass 'a request addressed by a public address is not the home network'
request GET "$LAN_URL/api/auth/state" -H 'Host: rebound.example'
expect_status 421 'a name the server does not answer to is refused (DNS rebinding)'

if [ -n "${HOME_PROXY_URL:-}" ]; then
  echo "The home network, through a reverse proxy on this machine"
  request GET "$HOME_PROXY_URL/api/auth/state" -H 'Host: kraftverk.local' -H 'X-Forwarded-For: 192.168.1.20'
  body_has '"canSetup":true' || fail 'a home name, through the proxy on this machine, is the home network'
  pass 'a home name, through the proxy on this machine, is the home network'
  request GET "$HOME_PROXY_URL/api/auth/state" -H "Host: $PUBLIC_HOST" -H 'X-Forwarded-For: 192.168.1.20'
  body_has '"canSetup":false' || fail 'a public name, even through that proxy, is not the home network'
  pass 'a public name, even through that proxy, is not the home network'
fi

echo "Setting up from home"
request GET "$LAN_URL/api/auth/state"
body_has '"canSetup":true' || fail 'the home network may set up a fresh server'
pass 'the home network may set up a fresh server'
request GET "$LAN_URL/api/devices"
expect_status 401 'the home network needs a login too'
password=$(head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 24)
request POST "$LAN_URL/api/auth/setup" -H 'Content-Type: application/json' \
  --data "{\"username\":\"smoke\",\"password\":\"$password\"}"
expect_status 403 'a write without the client header is refused (forgery)'
request POST "$LAN_URL/api/auth/setup" -H "$CLIENT" -H 'Content-Type: application/json' \
  --data "{\"username\":\"smoke\",\"password\":\"$password\"}"
expect_status 201 'the first account is created from home'
header_has 'set-cookie: kraftverk_session=.*HttpOnly' || fail 'the session is an HttpOnly cookie'
pass 'the session is an HttpOnly cookie'
# Sent back by hand rather than through curl's cookie jar, which will not
# return a cookie to a host with no dot in its name, which SMOKE_HOST may be.
session="Cookie: $(grep -io 'kraftverk_session=[^;]*' "$work/headers" | head -n 1)"
request POST "$LAN_URL/api/auth/setup" -H "$CLIENT" -H 'Content-Type: application/json' \
  --data '{"username":"second","password":"correct horse battery staple"}'
expect_status 409 'there is only ever one first account'
request GET "$LAN_URL/api/devices" -H "$session"
expect_status 200 'signed in, the devices answer'
request POST "$LAN_URL/api/grid/relay" -H "$session" -H 'Content-Type: text/plain' --data '{"on":false}'
expect_status 403 'a forged write is refused even with a session'
request POST "$LAN_URL/api/users" -H "$session" -H "$CLIENT" -H 'Content-Type: application/json' \
  --data '{"username":"backdoor","password":"correct horse battery staple"}'
expect_status 400 'a session alone cannot add an account'
request POST "$LAN_URL/api/users" -H "$session" -H "$CLIENT" -H 'Content-Type: application/json' \
  --data "{\"username\":\"backdoor\",\"password\":\"correct horse battery staple\",\"yourPassword\":\"not the password at all\"}"
expect_status 403 '…nor with a wrong password to confirm it'

echo "Signing in from the internet"
request POST "$PUBLIC_URL/api/auth/login" -H "Host: $PUBLIC_HOST" -H "$CLIENT" -H 'Content-Type: application/json' \
  --data "{\"username\":\"smoke\",\"password\":\"$password\"}"
expect_status 200 'the account signs in from the internet'
header_has 'set-cookie: kraftverk_session=.*Secure' || fail 'over a Secure cookie'
pass 'over a Secure cookie'
request POST "$PUBLIC_URL/api/auth/login" -H "Host: $PUBLIC_HOST" -H "$CLIENT" -H 'Content-Type: application/json' \
  --data '{"username":"smoke","password":"not the password at all"}'
expect_status 401 'a wrong password is refused'
# A reverse proxy appends the address it saw to whatever the client sent; the
# client's own entry, on the left, must not be the one that is counted.
request POST "$PUBLIC_URL/api/auth/login" -H "Host: $PUBLIC_HOST" -H "$CLIENT" -H 'Content-Type: application/json' \
  -H 'X-Forwarded-For: 203.0.113.66, 198.51.100.23' --data '{"username":"smoke","password":"a spoofed guess"}'
expect_status 401 'a guess with a forged forwarding header is refused'
request GET "$LAN_URL/api/audit?limit=5" -H "$session"
body_has '198.51.100.23' || fail 'the address the proxy saw is the one recorded'
! body_has '203.0.113.66' || fail 'the address the client claimed is not recorded'
pass 'the address the proxy saw is recorded, not the one the client claimed'

echo "$passed checks passed"
