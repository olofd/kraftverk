# iCloud sign-in: what Apple asks now, and how kraftverk keeps up

The plan for signing in to an Apple ID that works the first time, gets the code
to the person's iPhone, and then stays signed in for months with no one. It
also covers the research behind it, 2026-10-08.

## 1. Why: what went wrong

The owner tried to add an iCloud account many times one evening and again the
next morning. It never got past the code. The server's logs said only `200`.
Reading the screen, the code and Apple's answers showed three separate faults.

1. **The button could not work until the step was left.** "Sign in with
   Apple" read only *saved* fields, and only the step's Continue saved them,
   which also moved on to the check. So every early press failed in a few
   milliseconds without reaching Apple. Its card sat above the fields it
   needed, and the step had two Continue buttons.
2. **Apple changed its sign-in, as it does several times a year.** In 2026:
   - **The code must be asked for.** Apple no longer pushes it to the trusted
     devices by itself after the password. The old `POST
     /verify/trusteddevice` answers 405. The code is asked for with `PUT
     /appleauth/auth/verify/trusteddevice/securitycode` (empty body), or, for
     an account Apple routes to it, through the HSA2 *bridge* (§3.3).
   - **The options moved.** How a second factor can be given (the route,
     trusted numbers, the bridge's data) is now in the HTML shell's
     `<script class="boot_args">` or nested under `direct.twoSV`. Our parser
     read only the top level, found no phones, and so never offered a text.
   - **A correct code may answer 409** with `{"securityCode":{"valid":true}}`
     instead of 204. This was already accepted.
   - **An escrow proof may follow.** A 409 to `signin/complete` that carries
     `X-Apple-EDP` or `X-Apple-PDP` asks for a second SRP proof. Without it,
     Apple asks for a code at every sign-in.
3. **The setup framework lost state.**
   - A refused turn that carried a question (a mistyped code) dropped the
     question's form. The next press was read as an empty code, and the flow
     dead-ended.
   - A half-finished sign-in's carried state stayed on the server and
     hijacked the next fresh press.
   - "Sign in again" loaded neither the password nor the kept session, so the
     trust token was thrown away and a code asked for again.
   - No action's outcome was logged. Two `503`s that morning were Apple
     throttling the account after the evening's retries, and nothing said so.

## 2. What exists elsewhere (researched 2026-10-08)

No Node library is fit to depend on. One project implements the bridge.

| Project | Language, licence | Sign-in | Code by device | Bridge | SMS | Escrow | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| timlaing/pyicloud (Home Assistant's) | Python, MIT | SRP s2k/s2k_fo | PUT, 409 accepted (#372) | **yes**: `hsa2_bridge.py` 1729 lines, `hsa2_bridge_prover.py` 591 | yes | no | Active (v2.7.0, 2026-09). The reference |
| steilerDev/icloud-photos-sync | TypeScript, **GPL-3** | own SRP | PUT, 409 | no | yes, phones from every shape | **yes** | Read its PR descriptions (#1104, #1124) for behaviour, never its code |
| ticaki/ioBroker.icloud | TypeScript, MIT | SRP (icloud.js fork) | PUT, 409 | no | yes | no | A home-automation adapter with re-login backoff; Node only |
| foxt/icloud.js (`icloudjs`) | TypeScript, MIT | SRP via `@foxt/js-srp` | old POST, 204 only | no | no | no | Unmaintained for auth since 2024 |
| icloud-photos-downloader (`pyicloud_ipd`) | Python, MIT | SRP | PUT, 409 | no | yes | no | Widely used; issue tracker documents 503s |
| gcobb321/icloud3 | Python, MIT | own | PUT | no | yes | no | Re-authenticates at half the trust's life; 503 handling |
| rclone `backend/iclouddrive` | Go, MIT | SRP | PUT, 409 | no | yes | no | A good cross-check (`srp.go`) |

Other npm packages (`apple-icloud`, `find-my-iphone`, `icloud`, `icloud-api`)
are dead and sign in with a plain password, which Apple refuses. Rust crates
and FindMy.py use GrandSlam (`gsa.apple.com`, Apple devices' own sign-in), not
this one.

**What we take, and from where:**
- Our own SRP (`srp.ts`) stays. It matches pysrp and is tested against a
  server that holds only the verifier.
- From pyicloud, ported as before (MIT, credited in the package's NOTICE):
  options parsing, the bridge, the prover, keep-alive, and the order of
  methods.
- Escrow and phone parsing are written from icloud-photos-sync's described
  behaviour, and tested against a fake. No GPL code is copied.

### What is known about how long a sign-in lasts

- **Trust.** `2sv/trust` gives a trust token and the `X-APPLE-WEBAUTH-HSA-TRUST`
  cookie.
  - Its life is about 90 days by iCloud3, "two months" by icloudpd, and 30
    days by rclone. It differs by account, so read the cookie's own expiry.
  - Within it, signing in with the password and the trust token asks no code.
- **Session.**
  - `accountLogin` with `extended_login: true` gives a session of weeks.
  - `setup/ws/1/validate` checks it with no password and rolls its cookies.
  - 421, 450 or 500 from an iCloud service means "sign in again".
- **Renewal.** iCloud3 re-authenticates at 45 days, half the trust's life, so
  a person never sees a code between.
- **Throttling.**
  - A 503 from `idmsa.apple.com` after several attempts is Apple suspecting
    fraud. The block lasts hours, sometimes a day, and every retry extends it.
  - iCloud3 waits at least 15 minutes and loops never.
- **The `scnt` header.** Apple changes it with every answer. Sending a stale
  one looks exactly like a wrong code.

### What the best flows look like

| Source | What it does |
| --- | --- |
| Home Assistant (`icloud` config flow) | Credentials, then a code. Reauth keeps the Apple ID and asks only the password. "Request new code" warns that it invalidates the last |
| iCloud3 3.5 | "Request authentication code", "Apple did not send me a code", "Change authentication method" (which device or number) |
| Apple ([support 102606](https://support.apple.com/en-us/102606)) | Allow on the device shows the code. "Didn't get a code?" offers a text or a call to a trusted number, or Settings → name → Sign-In & Security → Get Verification Code |
| web.dev, GOV.UK | One primary action, after the fields. `autocomplete=username`, `current-password`, `one-time-code`. Paste fills every box. Keep what was typed. Errors beside the field. Resend with a cooldown |

## 3. The design

### 3.1 The screens

1. **Your Apple Account.**
   - Apple ID and password.
   - One button, **Sign in**, that signs in with what is typed. It is not
     called "Sign in with Apple", which is Apple's own OAuth product.
2. **Enter the code.**
   - Asked for automatically: "Apple shows a 6-digit code on your iPhone,
     iPad or Mac. Tap Allow, then type it here."
   - Six boxes: paste fills them; checked a moment after the last digit; kept
     on a wrong code.
   - **Didn't get a code?** offers:
     - send again to my devices, with a cooldown (30, 60, then 120 s);
     - text, or call, each trusted number (•••• 12);
     - get one in Settings on an iPhone.
3. **Signed in: 5 devices in Find My.** Then choosing them, as today.

Each dead end has its own sentence:
- Apple refusing for a while, with the time to try again and the button
  waiting until then.
- Find My off everywhere.
- No trusted number.
- Security keys, which kraftverk cannot use yet.
- Advanced Data Protection with web access off.

Signing in again from the account's page keeps the Apple ID, asks for the
password only when it is gone, and usually needs only the code.

### 3.2 Staying signed in, with no one

- **Kept state.** What the session keeps, `IcloudState` in the connection's
  session secret, gains:
  - `trustUntil`: the trust cookie's expiry;
  - `renewedAt`;
  - `nextSignInAt` and `attempts`: the backoff, which so outlives a restart.
- **Keep-alive.**
  - `validate` every 30 minutes, between Find My's polls.
  - Every answer's cookies are kept, as they are today, through `onChange`
    into the session secret.
- **Renewal.** Past half the trust's life, sign in once with the password, the
  trust token and escrow, which rolls the trust with no code.
- **Backoff.**
  - At most one silent sign-in per 15 minutes, doubling on a 503 up to 6
    hours.
  - A refused password is `needs-you` at once and never retried.
  - The re-sign Find My's errors trigger is bound by the same backoff.
- **Health.**
  - "Signed in until 3 Jan" while all is well.
  - A warning a week ahead if renewal keeps failing.
  - `needs-you` with "Apple asks for a code again", linking to the one-tap
    re-sign.

### 3.3 The bridge: a code as a prompt on the iPhone

The bridge is used when Apple's options say `authInitialRoute ==
auth/bridge/step` and carry `bridgeInitiateData`.

**Starting it, which shows the prompt on the trusted devices:**
- open a WebSocket to `websocket.push.apple.com/v2/<connection message>`,
  where the connection message carries an ephemeral P-256 key and a signed
  nonce;
- receive a push token;
- filter to Apple's topic;
- `POST /bridge/step/0`;
- wait for the push carrying the session, the next step and the salt.

**Checking the typed code:**
- when Apple's transaction id ends `_W`, the legacy
  `verify/trusteddevice/securitycode` endpoint;
- otherwise SPAKE2 on P-256 (`SPAKE2Web`, the code stretched with scrypt),
  over steps 2 and 4 on the same socket, then the code Apple encrypted
  (AES-GCM) to `bridge/code/validate`, then the closing step.

**The order of methods:** the bridge when Apple routes there; the PUT
otherwise; a text when either fails.

### 3.4 Where it fits in kraftverk

- **The integration** (`packages/integrations/icloud`) keeps everything Apple:
  - `protocol/auth.ts`: sign-in, second factor, trust, escrow, validate;
  - `protocol/options.ts`: Apple's options, from both shapes;
  - `protocol/bridge.ts`, `protocol/bridge-prover.ts`: the bridge;
  - `account.ts`: keep-alive, renewal, backoff, health.
  - It stays pure: the SDK and `@noble/*` (pure JavaScript, already used by
    `apple-media`) are all it imports.
- **The SDK and the `https` transport** gain a WebSocket channel to declared
  hosts only (`wss://websocket.push.apple.com`), with the `Origin` and
  `User-Agent` Apple's push service wants. A protocol reaches it only through
  its channel, as it reaches `https` today.
- **The setup framework** gains, for every integration:
  - **Held live state.** A setup action may hold something live (an open
    socket) across its turns: `ctx.held`, closed when the draft expires, is
    left or is saved. It is generalised from `apple-media`'s pairing, which
    moves onto it.
  - **A primary action.** A sign-in action marked `primary` *is* the step's
    Continue: the fields first, then one button that sends what is typed.
  - **Kept questions.** A refused turn keeps its question. A fresh turn drops
    a stale carry. Every turn refreshes the draft and logs its outcome.
  - **Signing in again** starts from the kept session and the person's
    secrets.
  - **A code field.** `presentation: 'code'` draws the six boxes, a component
    in `packages/ui`.
- **The holder, gateway and store do not change.** The account is a bridge
  device as before. What it keeps stays in its connection's secrets, sealed.

## 4. The order of work

Each step is green (`typecheck`, `test`, `check:architecture`, `knip`) and
pushed. Each is tried against Apple once, never in a loop.

1. **Signed in today.**
   - Apple's options from both shapes.
   - The code asked for (PUT), with a text offered from the trusted numbers.
   - Headers as pyicloud's.
   - 503 as "busy until".
   - Each Apple step logged.
   - The action signs in from what is typed.
   - The check uses the session it made.
2. **The setup framework.** Kept questions, the carry's life, the draft's TTL,
   `held`, the primary action, signing in again from the kept session, the
   code field.
3. **The iCloud screens.** As §3.1.
4. **Staying signed in.** Escrow, keep-alive, renewal, backoff, health. As
   §3.2.
5. **The bridge.** The WebSocket channel, the crypto, the port and its tests.
   As §3.3.
6. **The package's README rewritten,** and this document's open points
   closed.
