# kraftverk app — the screens, on a phone and in a browser

## What it is

The kraftverk app: one Expo app for iOS and the web. It shows a home and
lets a person run it — devices, automations, configuration, accounts — and
it is a kraftverk node of its own: with no server it keeps the home itself
(in its process on a phone, in a worker in a browser); with one, it follows
the server's home and holds what only it can reach, its own Bluetooth.

## What it does — and does not

- **Does:** draw screens, and give them what only a device can: where the
  home is opened (`src/platform/home`), its preferences, what it is
  (`platform/here.ts`), the platform's dialog, downloads, the servers it
  knows. Every screen asks the home through one interface, `KraftverkApi`
  (`useFamily().api`), whether the home is a server's or its own.
- **Does not:** decide anything about a home. What a device is, what the
  gateway allows, how an automation reads, what an import still needs, what
  a step of the add flow comes next: the shared packages say, and the same
  code runs on the server. Nor does it decide behaviour from which node it
  is: this node's role (`useFamily().role`) chooses words — "through your
  server", "from this phone" (`useReach`) — never what a screen does.

## Where it fits

An edge (docs/PLAN-SHARED-CORE.md), beside the server: it builds a home from
`@kraftverk/hub` where it keeps its own, reaches a server's over HTTP with
`@kraftverk/api-client`, and draws with `@kraftverk/ui`. The installed
device packages' own screens are bound in by `npm run gen:devices`
(`src/generated/registry.ts`).

## Why a package of its own

Because a person needs one app on every device they own, and a home that
keeps working without a server: the app is where a phone's own radio and a
browser's storage meet the home, and nowhere else is.

## Where code goes

```
app/                 routes: each renders one screen and nothing else
src/
  features/          the screens, by what they are about
    home/ add/ devices/ automations/ config/ settings/ auth/
  components/        pieces any screen uses: Screen, Loading, ErrorText,
                     Picker, the YAML editor; useAttempt, useAnswer, the tone
  state/             the providers — servers, sign-in, the home, its devices —
                     and hooks over them (useReach, useShowing)
  platform/          what only the device gives: where the home runs, its
                     preferences, the dialog, downloads, the known servers
  generated/         the installed packages' screens (npm run gen:devices)
```

- A route is thin: it reads its parameters and renders a feature's screen.
- Logic — anything that would read the same with no screen — belongs in a
  package, not here: `@kraftverk/api-client` for the app's side of the API,
  the language's and the runtime's packages for the rest. The architecture
  check refuses a `.ts` file here with no screen in it
  (`npm run check:architecture`).
- A screen tries what a person asks with `useAttempt`, reads what it shows
  with `useAnswer`, and says what went wrong with `ErrorText`.
- A file is named for what it exports.
