# @kraftverk/sign-in-apple — Sign in with Apple

## What it is

Apple as a sign-in provider a kraftverk account may link
(docs/PLAN-WORLD-MODEL.md §10.6): making an account with *Continue with
Apple* — or opening one again on a device that keeps it — instead of as a
local account. Either way the account is the same: a person, a key on the
device, twelve recovery words. Apple only adds a way back in.

## What it does — and does not

- **Does:**
  - declare Apple as a provider: its id, its name, the issuer of its
    tokens, and where its signing keys are published (`APPLE`) — what a
    server checks a token by (`verifyIdToken` in `@kraftverk/identity`);
  - ask the platform for a token (`./client`): on an iPhone, iOS's own
    sheet, through `expo-apple-authentication`; in a browser, Apple's own
    page in a pop-up, through Apple's JS — offered only where the app was
    built with a Services ID Apple knows for that site
    (`EXPO_PUBLIC_APPLE_SERVICES_ID`, `EXPO_PUBLIC_APPLE_REDIRECT_URI`),
    over HTTPS. Android has no sheet, and is told so.
- **Does not:** keep anything, make an account, or decide whether a token
  lets anyone in — the app links the identity in the person's own chain;
  a family's master takes it as a way back for them; a server checks it.
  Nothing is sent to Apple but the sign-in itself.

## Where it fits

A product package, as an integration is: the core names no product, so
Apple's name and code are here. It imports only `@kraftverk/identity` of
the core — the provider's shape, and reading a token. The app finds it in
its generated list (`client/src/generated/sign-in.ts`, by
`npm run gen:devices`); its `.web.ts` file is the browser's, as Metro
picks it.

## Why a package of its own

Because a sign-in provider is a product, with an SDK of its own (a native
module on a phone, a script in a browser) and rules of its own (a Services
ID, a registered address). Kept here, adding another provider is adding a
package, and the app and the server stay the same.
