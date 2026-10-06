# Contributing to kraftverk

Thank you for looking. The most valuable thing you can bring is **a device**:
support for a product nobody else supports well, or evidence that yours differs
from what kraftverk assumes.

## Ways to help

| You have… | Do this |
| --- | --- |
| A device kraftverk does not support | Open a [**Support my device**](https://github.com/olofd/kraftverk/issues/new?template=support-my-device.yml) issue — or write the package yourself (below) |
| A supported device that behaves differently | Open a [**My device differs**](https://github.com/olofd/kraftverk/issues/new?template=device-differs.yml) issue, with a register dump or a capture |
| Something broken | Open a [**Bug**](https://github.com/olofd/kraftverk/issues/new?template=bug.yml) issue |
| A security problem | Do **not** open an issue — see [SECURITY.md](.github/SECURITY.md) |

## Writing a device package

```bash
npm install
npm run new:protocol -- acme
npm run new:integration -- acme
npm run new:device -- acme-plug acme
npm test --workspace @kraftverk/device-acme-plug
```

That is a protocol, a platform that speaks it, and a product on it —
working packages, a simulator that keeps the contract — which the server
finds at start. A product on a platform kraftverk already knows is the
`new:device` line alone, naming that integration. [docs/ADDING-A-DEVICE.md](docs/ADDING-A-DEVICE.md)
walks through making it true: what it is, what it measures, how it is reached,
who it is, its session, its simulator, its tests. A device that deserves more
than the generic pages ships its own screens in the same package.

**Writing it with an AI coding agent is welcome.** The contract, the simulator,
the contract test and the architecture check are there so that you — and the
agent — find out quickly when something is wrong. The checks are the same
however the code was written.

### Rules that keep people's hardware alive

These are not style. A pull request that breaks one is not merged.

- **Every physical action goes through the gateway.** A device type never
  switches, writes or sends anything on its own initiative.
- **A protocol's guard is not optional.** Writes a device must never receive —
  a register that bricks it — are refused in the protocol package, with a test.
- **Settings that can damage hardware are marked `dangerous`,** so a person
  confirms them and an automation never can.
- **Support levels are honest.** `verified` means someone ran it against real
  hardware and wrote down what they saw; until then it is `experimental`.
- **Evidence, not hope.** A claim about how a device behaves comes with how it
  was observed: a capture, a register dump, a test against recorded bytes.

### Rules that keep the repository clean

- **Nothing about anyone's home.** No real IP addresses, host names, MAC
  addresses, device ids or keys — in code, tests, captures or docs. Tests use
  the documentation ranges (`192.0.2.x`, `198.51.100.x`) and made-up ids.
- **Device-specific code stays in its package.** `npm run check:architecture`
  fails if a product's name or quirk leaks into the core.
- **Strict version 1, for now.** kraftverk is in research and development:
  nothing is kept backward compatible, a change to the model is made
  everywhere at once, and the database is one schema, not a migration chain
  ([AGENTS.md](AGENTS.md)). From the first release on, keys become stable
  forever — history is stored under them.

## Before you open a pull request

```bash
npm run typecheck
npm test
npm run check:architecture
```

All three run on every push, on GitHub, together with a build of the Docker
images and an attack on the running stack ([docs/CI.md](docs/CI.md)).

[docs/DEVELOPING.md](docs/DEVELOPING.md) covers the tests and where everything
lives; [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) is the design, and the
authority when something is unclear.

## Licence

By contributing you agree that your contribution is licensed under the
project's [MIT licence](LICENSE).
