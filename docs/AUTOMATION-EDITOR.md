# The automation editor: automations you build from blocks

Written 2026-09-30, from the owner's decision (docs/PLAN-RUN-AND-CHAIN.md,
"An automation editor, not a recipe picker"). This replaces Phase 2 of that
plan. It builds on docs/AUTOMATIONS.md and docs/SEQUENCES.md: the language
they describe stays; who writes a rule changes.

**Status:** built, 2026-09-30, as written here: the editor at
`client/app/automation/[id].tsx` and `client/src/features/automations/editor`,
the rule kept and checked by the home (`plans` in `@kraftverk/hub`),
and e2e in `e2e/sequences.e2e.ts` and `e2e/charge-window.e2e.ts`.

## The problem

The language is general: triggers, conditions, and steps that nest (do,
pause, wait until, make sure, choose, watch). But only a package can write
a rule, as a recipe. An automation is a recipe's id, its settings and the
parts that fill its roles. So a person can only pick what a package
foresaw and move its sliders:
- they cannot add a step, drop one, reorder, or nest one in another;
- they cannot switch the plug's fast refresh on once it is reached — a
  setting its device offers, which no rule can write today;
- they cannot start one automation from another;
- they cannot give a sequence a clock of its own.

## Decisions

1. **Every automation owns its rule.** The rule is stored with the
   automation, whole. Nothing an automation does depends on a package
   still shipping the recipe it came from.
2. **Recipes are starting points.** "New automation" offers an empty one,
   or a copy of a recipe. Copied, the recipe's settings become the plain
   values in its blocks (`inlineParams`); the copy is the owner's, edited
   like any other. An automation remembers which recipe it came from, only
   to say so.
3. **Blocks are the language's steps**, with two more:
   - **Change a setting**: write a value to a setting a part offers.
   - **Start another automation**: and optionally wait for it to end.
4. **Play runs any automation.** Pressing play runs it now, for real,
   through the gateway: its "only if" is still checked, then its steps.
   - The mode — Off, Only watch, Act — governs only what it does on its
     own: its triggers.
   - Off means no one can run it: not a person, not another automation.
   - Played while only watching, the app asks first, once per press.
   - An assistant may play only an automation that is let act: a person's
     arming is its yes.
   - So the trigger "when you start it" (`asked`) goes. Every automation
     can be played, and one with no trigger is only ever played or
     started.
5. **Timers belong to the rule.** "At a time" takes weekdays. There is no
   separate schedule: a timer is a trigger like any other.
6. **Roles stay, and the editor hides them.** Blocks name parts through
   the rule's roles, as recipes do, so the engine, the binding check and
   rehearsal stay as they are.
   - When a person picks a part in a block, the editor uses that part's
     role if the rule has one, or adds one.
   - A role that nothing uses any more is dropped on save.
   - A role can also be filled by an automation, for "start another".
7. **The server checks every draft, not only every save.** The editor
   sends the draft as it changes and shows what is wrong, and how it
   reads, as the person builds.
   - One checker, on the server: the app never judges a rule by itself.
   - The words for each block, as it is typed, come from the SDK's pure
     describers, in the app (`editor/context.tsx`) — the same code the
     server runs, so they agree; the server's check stays the authority on
     problems and on the saved sentence. (Amended 2026-10-01: this decision
     first said only the server describes.)

## The language, as it changes (`packages/automation/src/rule.ts`)

```ts
type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

type Trigger =
  | { at: Expr; days?: readonly Weekday[] }            // every day, or only these
  | { event: { role: string; event: string } }
  | { becomes: Expr; heldForMinutes?: Expr };          // `asked` is gone: anything can be played

type Step =
  | …                                                   // command, wait, waitUntil, ensure, choose, watch
  | { write: { role: string; key: string; value: Expr } }
  | { start: { role: string; waitSeconds?: Expr } };   // an automation's role; with a wait, until it ends

type RoleSpec =
  | (CapabilityNeed & { label: string; description: string })   // a part
  | { automation: true; label: string; description: string };  // an automation, to start
```

**Change a setting** (`write`):
- It names the attribute by its key: a rule the owner builds is bound to
  their own devices, so keys are what the editor has.
- Checked when bound: the part has that attribute, it can be written, and
  it is not declared dangerous.
- The value fits the attribute's type.
- It goes through the gateway's write path, read back like any setting.
- "Already so" when the part already reads the value.
- Recipes cannot use it until settings get standard meanings (Phase 4 of
  the plan).

**Start another automation** (`start`):
- Its role is filled by an automation (see Roles).
- It starts that automation's run, as a person's play would, but asked by
  the run that started it. A person's play gives the whole chain a
  person's dwell; a trigger gives it an automation's.
- It is refused, as a step, when the other automation is off, already
  running, or would start one already in this chain.
- With `waitSeconds`, the step lasts until that run ends — and succeeds if
  it acted — or times out. Without it, the step is done once the run has
  begun.
- Stopping a run stops a run it waits on.
- Where it may stand:
  - In `then` and in choices.
  - In a retry or `otherwise` only without a wait: nothing there waits for
    what might not come.

**Checker (`checkRule`), in addition:**
- A rule an automation owns has no settings: `params` is empty. Every value
  is in its blocks, since a copied recipe's settings were written in.
- `days`: at least one, no repeats.
- Chains: at most four automations deep, and no cycle.
  - The server checks both when an automation is saved: it follows every
    `start` role through the automations they name.
  - The engine checks again as it runs: a chain a later edit made too
    deep is refused, not run.

**Saying it:**
- `describeSteps`, `describeTriggers` and `describeRule` learn the new
  forms:
  - "Set Scooter plug's Live readings to on";
  - "Start “Start charging the scooter” and wait until it ends — at most
    5 min";
  - "At 07:00 on weekdays".
- A recipe's `sentence` stays for its own card in the list of starting
  points; an automation reads as its rule.

**`inlineParams(recipe, values): Rule`** writes a recipe's settings into its
blocks: every `{ param }` becomes `{ value }`, a choice its settings decide
becomes the steps it chose (`settledChoice`), and `params` is emptied.

## Data model (one schema change)

```sql
-- An automation owns its rule.
CREATE TABLE automation (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  rule            TEXT NOT NULL,          -- JSON: Rule, params empty; checked before it is kept
  made_from       TEXT,                   -- the recipe it was copied from; NULL: built from nothing
  time_zone       TEXT NOT NULL,
  mode            TEXT NOT NULL CHECK (mode IN ('off', 'watch', 'act')),
  recheck_minutes INTEGER CHECK (recheck_minutes IS NULL OR recheck_minutes BETWEEN 1 AND 1440),
  home_place      INTEGER CHECK (home_place IS NULL OR home_place >= 0),  -- on the home page, and where; NULL: not on it
  looked_at       TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX automation_home ON automation (home_place) WHERE home_place IS NOT NULL;

-- A role is filled by a part of a device, or by another automation.
CREATE TABLE automation_role (
  automation_id TEXT NOT NULL REFERENCES automation (id) ON DELETE CASCADE,
  role          TEXT NOT NULL,
  device_id     TEXT REFERENCES device (id) ON DELETE CASCADE,
  part          TEXT,
  starts        TEXT REFERENCES automation (id) ON DELETE CASCADE,
  PRIMARY KEY (automation_id, role),
  CHECK ((device_id IS NOT NULL AND part IS NOT NULL AND starts IS NULL)
      OR (device_id IS NULL AND part IS NULL AND starts IS NOT NULL))
);
CREATE INDEX automation_role_device ON automation_role (device_id);
CREATE INDEX automation_role_starts ON automation_role (starts);

-- automation_run gains which run started it.
started_by_run TEXT REFERENCES automation_run (id) ON DELETE SET NULL
```

- `recipe` and `params` leave the automation: the rule holds what they
  held.
- `automation_trigger` stays, keyed by a trigger's place in the rule.
  Editing the rule already starts its triggers afresh, so a place never
  means two triggers.
- Every NULL means something: built from nothing; not on the home page; a
  role an automation fills; a run nothing else started.
- An automation deleted takes with it the roles that would start it. The
  automations that used it then say "a role has nothing to start", as they
  say "no device" for a deleted device.

The home server's database is set aside once, when this ships: its four
devices and two automations are added again.

## The engine (`packages/automation-engine/src/engine.ts`)

- **Reads the rule** from the automation, not from the library. The
  library is only where starting points come from.
- **Play (`startAsked`)**: it runs whatever the mode, but is refused when
  off; an agent is refused when the automation only watches. A rule of
  commands alone runs at once, as before.
- **`at` with days**: due only on those days, on the owner's clock (the
  same `#dueAt`).
- **Write steps**: through `gateway.write`, actor automation, with the
  run's reason.
- **Start steps**: `startAsked` from inside a run.
  - What it carries: the run that started it (`started_by_run`), who asked
    (the chain's first asker), and how deep the chain is.
  - With a wait, the step polls the other run as a wait does, and a stop
    passes down.
- **What it would do** (only watching, or asked):
  - A start step says "Would start …".
  - A write step says what it would set, and whether it is already so.

## The API (`server/src/routes/automations.ts`, docs/API.md)

| Route | What |
|---|---|
| `GET /automations/recipes` | Starting points: each recipe with its rule, settings and roles, and how it reads |
| `POST /automations/draft` | `{ rule, roles }` → `{ problems, sentence, when, steps, otherwise }`: checked and said, nothing kept. The editor sends it as the draft changes |
| `POST /automations` | `{ name, rule, roles, madeFrom?, timeZone, recheckMinutes? }`; checked as a draft is, plus the chain |
| `PATCH /automations/:id` | `name`, `rule` with `roles`, `mode`, `recheckMinutes`, `homePlace`; a rule changed while it acts is confirmed, as today |
| `POST /automations/:id/start` | Play: 200 with the run; 409 when off or already running |
| `POST /automations/:id/check` | What it would do now (unchanged) |

- `AutomationView` carries `rule`, `roles` (bound, with their names),
  `madeFrom`, `homePlace`, and how it reads (sentence, triggers, steps,
  otherwise).
- `startsWhenAsked` goes.
- `AutomationRun` gains `startedByRun: { id, automationId, name } | null`.

The assistant's tools follow: `automations` lists, `start` plays (only one
that acts), and `stop` stops. It does not build rules; a person does.

## The app

**The list (`/automations`), since 2026-10-01 (docs/AUTOMATIONS-UX.md):**
- Each automation is a small card — what starts it, its name, how it
  stands in a line, and a play button (■ Stop while it runs). The same
  card on the home page and on a device's page.
- Its name opens **its own page** (`/automation/:id`): Run, Edit, ⋯ (What
  would it do now, Rehearse, Delete), and each part of it in a group of its
  own — When, Only if, Does, If a step fails, Right now, On its own (the
  mode), Activity. Edit turns that page into its form, in place: the same
  groups, editable, with Cancel and Save kept below it. A new one is
  `/automation/new` — "Start from", then the same form.
- A device's page ends with the automations it takes part in — the same
  list, and New, which starts from that device.

**The home page:**
- A "Shortcuts" row, before the devices, with each automation put there
  (`homePlace`, in order).
- Each tile shows a play or stop button, the step it is in and the last
  outcome.
- "Show on the home page" is a switch on the card.

**The editor** (`/automation/[id]`; `/automation/new`, with or without a
recipe to start from), top to bottom:

1. **Name.**
2. **When it runs on its own** — the triggers, each a row that can be
   removed. "Add": at a time (a time and weekday chips: every day,
   weekdays, or chosen days), every so often (minutes, on the clock), when
   something holds (a condition, and for
   how long), or when a device says something (a part, and one of the
   events it declares). Under them: "You can always start it with ▶".
3. **Only if** — an optional condition.
4. **What it does** — the blocks, numbered and nested as the card shows
   them.
   - Each block is a card: its kind, what it says in words, and its fields
     when opened.
   - Between blocks, and at the end of each nested list, "+" adds one.
   - A block can be moved up or down within its list, and removed.
   - The kinds, each with its own fields:
     - **Switch / command**: a part, then one of the commands it offers,
       with arguments typed by the capability.
     - **Change a setting**: a part, then one of its writable settings
       that is not dangerous, and a value of its type.
     - **Pause**: seconds.
     - **Wait until**: a condition, and at most how long.
     - **Make sure**: a condition, how long each try is given, how many
       tries, and "each time" blocks.
     - **If / otherwise**: a condition, and two block lists.
     - **Watch**: a condition, for how long, and "if it stays so" / "if
       not" block lists.
     - **Start another automation**: which one, and whether to wait for
       it (at most how long).
5. **If a step does not succeed, or you stop it** — blocks, of the kinds
   allowed there.
6. **Check** — what the server says of the draft, as it changes: problems
   first, each with the block it is about, then the sentence.

**The condition editor** builds an expression without showing one:
- A row is a part and something it reports, compared with a value in that
  reading's own unit or options; or "can be reached"; or the time of day,
  between two times (across midnight when the second comes first); or a
  function a package offers ("looks sunny by Weather"), with its arguments.
- Rows are joined with "all of" or "any of". A group can hold a group, and
  a row can be turned into "not".
- A condition the editor cannot draw as rows is shown in words, and can
  only be replaced as a whole. A copied recipe never gives one, but a
  future package might.

**The part picker** lists the parts that can do what the block needs, as
roles do today. The parts the rule already uses come first, under the
names the draft uses.

## What stays

- The gateway, and every rule of it: dwell, confirmation, freshness, read
  back, a run's allowance.
- Runs, and the timeline.
- Modes, and "keep it so".
- Rehearsal: on a rule of the automation's own, the same as on a recipe.
- The language's limits: every wait bounded, every retry counted, four
  deep.
- Recipes in packages, as starting points.

## Order of work

Each step keeps the checks green, and each is committed on its own.

1. **The language** — types, checker, describer, `inlineParams`, and
   recipes without `asked` — with its tests.
2. **The schema, store and engine** — the rule kept, roles for
   automations, play for all, at on days, write and start steps, chains —
   with their tests.
3. **The API and its contract** — drafts checked, and HTTP tests.
4. **The list and the home page** — play, stop and shortcuts — checked in
   the browser.
5. **The editor** — blocks, conditions, triggers, the part picker, the live
   check — checked in the browser, and e2e: an automation built from
   nothing and one copied from a recipe, played, and one starting another.
6. **The docs** — AUTOMATIONS.md, SEQUENCES.md, DATA-MODEL.md, API.md and
   the plan.
