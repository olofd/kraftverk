# Reporting a security problem

kraftverk runs in people's homes and can switch real hardware, so a security
problem matters more here than in most software.

**Please do not open a public issue.** Report it privately through GitHub:
**Security → Report a vulnerability** on this repository. You will get an
answer, and credit in the fix if you want it.

Useful in a report: what an attacker needs (a position on the home network, a
signed-in account, nothing at all), what they gain, and how to reproduce it.

## What is in scope

The server, the app, the Docker images, the MQTT broker kraftverk runs, and
every package in this repository — including a device package that lets
something reach hardware it should not.

## How kraftverk defends itself

The model, and what it deliberately does not cover, is in
[docs/SECURITY.md](../docs/SECURITY.md): every endpoint behind sign-in, the
first account only from the home network, DNS-rebinding and CSRF defences,
secrets encrypted at rest, and every physical action through one audited
gateway.

## Supported versions

kraftverk is early and has no releases yet: fixes land on `main`.
