# Parts shared between automations, and a reserve the gateway keeps

Written 2026-09-30: Phase 3 of [PLAN-RUN-AND-CHAIN.md](PLAN-RUN-AND-CHAIN.md),
the two decisions every energy automation after it stands on. It builds on
[AUTOMATIONS.md](AUTOMATIONS.md), [SEQUENCES.md](SEQUENCES.md) and
[AUTOMATION-EDITOR.md](AUTOMATION-EDITOR.md).

**Status:** built, 2026-09-30, as written here.

## 1. Automations that share a part

### The problem

Two automations may act on one part, and often should: "Start charging" and
"Stop charging" both switch the charger's plug and the station's AC
outlets. Three things go wrong today.

- **Two runs at once.** "Stop charging", started by a timer, switches the
  plug off while "Start charging" is still making sure the charger draws —
  which then retries, switching it on again.
- **Keeping things so fights.** A charge window that keeps things so, and a
  forecast rule that switches the same plug off, undo each other at every
  recheck, and only the gateway's dwell stands between them.
- **Nobody sees it.** Nothing says that another automation switches the
  same part.

### Decided

- **A run holds the parts it may change.** From the moment it begins to act
  until it ends, a run holds every part its steps command or write — the
  parts filling its command and write roles, whichever way its choices go.
  A rule of commands alone holds them for the moment it acts; a sequence,
  for as long as it runs.
- **A chain holds together.** A run started by another run's step shares
  what the runs before it hold: "Morning" starting "Start charging" is one
  intent, not two.
- **Another automation's run is refused, not queued.** A run that needs a
  part held by a run of another chain does nothing, and says so: *"Scooter
  plug is in use by “Start charging”, running now."* It is kept as a
  refused run, on its card and the timeline. It does not wait: a run that
  waited would act later in a world that has moved on. What starts it
  starts it again — a condition still true when it is looked at again, the
  clock tomorrow, a person pressing play — and a step that started it fails
  with the reason, so its `otherwise` runs.
- **People and the assistant are never held.** A command from a person, or
  from an assistant for one, goes through the gateway as ever. A sequence
  whose part is switched under it finds out at its next check, as it would
  today. Holds are how automations take turns, not a lock on the house.
- **Keeping things so yields to other automations.** It switches back what
  a person or an assistant changed, as it was made to; it leaves what
  another automation set after it: *the last edge wins*. For that, the
  gateway's memory of each part and setting records who last switched or
  wrote it (`device_switch.switched_by`, `device_write.written_by`) beside
  when. An automation is named there by its id (`automation:a-…`), as the
  gateway's contract already says, so a rename changes nothing.
- **No priorities.** An order among automations would be a second language
  to learn and to read back. Holds decide who goes now; the last edge
  decides what stays.
- **Said on the card.** Each automation says which others change the same
  parts: *"Also changed by “Stop charging”: Scooter plug, Garage P280 — AC
  outlets."*
- **Not refused when made.** Sharing a part is how start and stop pairs are
  built; the checker says nothing about it.

## 2. A reserve the gateway keeps

### The problem

A station is a home's backup. An automation that turns its outlets on —
to charge a scooter, to export at a high price — drains it, and nothing
stops it at 3 % the night before a power cut. The gateway guards what is
switched off under a load; nothing guards what is switched on against the
battery behind it.

### Decided

- **A policy value, `reserveSoc`**, beside `loadWatts`: *"A reserve to
  keep"*, in percent, set in App settings → Safety. The default is **0: no
  reserve**. A reserve is the home's choice; one set for it would silently
  stop automations that already run.
- **Declared, not known by the gateway.** A capability command says what
  draws on the store behind its part: `switch.set` with `drains: { when: {
  arg: 'on', is: true } }`. The gateway knows no station: it applies the
  reserve when a command so declared would change something, the part's
  energy role is `load`, and its device has a `storage` part reporting
  `battery.soc` (the device's own, not a pack's).
- **Below the reserve**, or with the charge not known or read too long ago
  — unknown is never the safe answer — the command is **refused to
  automations and assistants** and **asked of a person**, in the gateway's
  words: *"Garage P280's charge is 18 %, below the 20 % reserve."* With no
  reserve set, nothing is read and nothing changes.
- **What is already so is not refused.** Outlets already on stay on; the
  reserve is about switching on, not about what a person left running.
- **Settings that discharge** — a station's discharge power, its export —
  come with Phase 4's standard meanings for settings: then a write may
  declare `drains` too. Until then a rule that writes one is the owner's,
  step by step, in the editor.

## Order of work

1. The ledger's `switched_by` and `written_by`; automations' commands
   and writes as `automation:<id>`.
2. Holds in the engine, the refused run, the chain; keeping things so
   yielding. Tests in `packages/hub/test/sequences.test.ts`.
3. `sharedWith` on each automation, and the card's line.
4. `reserveSoc` and `drains`, in the SDK and the gateway, with the
   gateway's tests; App settings → Safety shows it.
5. The docs: AUTOMATIONS.md, SEQUENCES.md, DATA-MODEL.md, API.md and the plan.

One schema change, so the database is set aside once.
