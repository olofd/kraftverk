# Automations in the app: a plan for the UX

Written 2026-10-01, after a review of the automation screens at phone size
(375 px) with five real automations: two copied sequences, a charge window,
the cheapest-hours recipe, and a chain. The owner's verdict: far from the
industry standard — pills and spacing look wrong on mobile, things leak out
of the viewport, and it is neither intuitive nor sharp. This plan is how it
gets there. It changes the app only: the language, the server and the API
stay as they are.

## What is wrong, measured

### The list is not a list

- **Five automations make a page of 5,836 px — seven phone screens.** Each
  automation is a full card, 900–1,250 px tall: sentence, origin, sharing
  notes, the run button, the whole step plan, "Right now", the last run, the
  mode, "Keep it so", the home-page toggle, four buttons and the history.
  Nothing on this page can be scanned.
- **The sentence reads like code** — "turn Laddare on if Garage P280's charge
  is below 50 %, off if not" — and then the steps say it again.
- **Words that contradict each other.** The badge says "Only watching" beside
  a Start button that acts for real. The last run reads "Last: would — Would
  turn Laddare off".
- **Metadata stacks up**: "Made from …", one "Also changed by …" line per
  other automation, each its own line under the sentence.
- **Delete sits beside Edit**, at the same weight, on every card.

### The editor is a long form, not an editor

- **Pill rows run off the screen.** The condition's kind is one row of six
  pills, 536 px wide in a 375 px screen: "Ask a package" is cut off, and
  "All of" and "Any of" cannot be seen at all. The comparisons ("below … is
  not") do the same. The rows are meant to wrap and do not.
- **One value, three controls.** A duration is a number box, then separate
  "s" and "min" pills beside it. A time of day is two number boxes. Neither
  looks like what it is, and a limit (a try is at most 10 minutes) is only
  learnt from an error after it is typed.
- **Every step carries three icon buttons** — up, down, and a red bin — which
  squeeze its words into a column a few words wide, and put a destructive
  red on every row. They are 28 px targets: under the 44 px minimum.
- **Labels say things twice.** Each step's uppercase kind ("SWITCH OR SEND")
  sits above a sentence that says the same.
- **Every section is always there**, empty ones explained in grey text. The
  check that says what is wrong is a box at the very bottom, far from the
  step it is about. Create is at the bottom too, off screen while you edit.
- **Nesting eats width**: each level indents, so a retry's steps are left
  with half a phone.
- **Choosing is done in long inline lists** that push the page down, rather
  than in sheets that come up from below.
- **Headers wrap**: "Change “Start charging”" takes two lines, and "Online"
  floats beside the subtitle.

### Things do not line up

- **Icons are nudged into place by hand.** Thirteen icons in the app are
  pushed down with `marginTop` of 2, 3 or 4 px, each tuned by eye, so no two
  rows agree: the add-step menu's icons sit 2 px above their titles.
- **An icon's box is not its glyph.** Feather is drawn from a font: its box
  is the line's height, not the glyph's, so a "+" centred by its box still
  looks high or low beside its label.
- **The left edge is ragged.** Section labels ("NAME", "WHAT IT DOES") start
  at 20 px, the cards under them at 16 px; nested steps start wherever their
  rail puts them.

## What good looks like

The references are the best automation builders there are: **Apple
Shortcuts** (a step is a sentence with tappable values), **Home Assistant's
editor** (when / and if / then, each block a card that folds), and **Google
Home's** and **SmartThings'** routines (a short list, a detail screen, and
setup in sheets). What they share:

1. **Summary first, details on demand.** A list is short rows; an automation
   has its own screen; settings live behind "Edit".
2. **The sentence is the interface.** A step reads "Turn **Scooter plug**
   **on**", and each bold value is a token: tap it, a sheet comes up, choose,
   done. No forms with labels.
3. **One control for one value**, each of the right kind: a time picker for a
   time, a duration field for a duration, a list in a sheet for a choice of
   many, a segmented control for two or three.
4. **Nothing ever leaves the screen.** Designed at 375 px, checked at 320.
   Every target at least 44 px.
5. **Quiet by default.** Rare actions (reorder, delete, rehearse) in a "⋯"
   menu; red only where something is about to be destroyed; one accent
   colour for the one primary action on the screen.
6. **Problems where they are.** A step with something wrong says so on the
   step; the bar at the bottom says whether it can be saved, and saves.

## The target

### 1. The list

A row per automation, about 72 px:

- An icon for how it starts (clock, repeat, condition, event, play), its
  **name**, and one line under it: what it does next or did last, in words —
  "Next at 07:00 on weekdays", "Running · Wait until Scooter plug can be
  reached · 0:42", "Turned Laddare off 2 min ago", "Only watching".
- A **play** button on the right (stop while it runs), as on the home page.
- A filter at the top: All · On their own · Started by you. "+ New" in the
  header.
- Shared parts, origin, mode and history move to the automation's screen.

### 2. An automation's screen

- **Header**: the name, big; a status line; **Run** as the one primary
  button; "⋯" for Edit, What would it do now, Rehearse last week, Duplicate,
  Delete.
- **How it runs**, as a short vertical flow — *When* → *Only if* → *Does* →
  *If it fails* — each a few lines of plain sentence, not the whole step
  form. Nested steps fold.
- **Right now**: each condition with a tick or a dash and the reading it
  stands on — as today, tighter.
- **On its own**: the mode as a segmented control with plain words — *Off ·
  Watch only · Act* — and one sentence under it saying what that means.
  "Keep it so" and "On the home page" as rows under it.
- **Activity**: the last run, and the history, as a timeline you open.

### 3. The editor

- **Title is the name**, editable in place. A sticky bottom bar: a small
  status ("Ready" / "2 things to fix") and **Save**.
- **Four sections as cards**: *When* (triggers), *Only if* (a condition),
  *Do* (steps), *If a step fails or you stop it* — the last folded until
  used. Empty sections are one line with a "+", not a paragraph.
- **A step is a sentence with tokens**: "Turn [Scooter plug] [on]", "Wait
  until [Scooter plug] [can be reached] — at most [2 min]". Tapping a token
  opens a **bottom sheet** for that one value. No uppercase kind label: the
  icon says what kind it is.
- **Each step has a drag handle and a "⋯"** (move up, move down, duplicate,
  delete — the buttons a keyboard and a screen reader need). No icon rows,
  no red bins.
- **"+" between steps** inserts there; the add sheet lists the kinds grouped
  (*Act*: switch, change a setting, start an automation · *Wait*: pause, wait
  until · *Decide*: if, make sure, watch), each with its one-line "says".
- **Nested steps** show as an indented card with a thin rail, folded to one
  line when not being edited, so width is not spent on every level.
- **Conditions** read as one sentence too: "[Garage P280]'s [charge] is
  [below] [15 %]". "All of / Any of" is a group card with "+ condition". The
  kind of a new condition is chosen in a sheet, not a row of six pills.
- **Problems on the step**: a red dot and the message under the step it is
  about (the server already says "Step 2: …"); the bottom bar counts them
  and scrolls to the first.

### 4. The controls

| Value | Now | Becomes |
|---|---|---|
| Duration | number box + "s" / "min" pills | **one field**, "20 s", opening a sheet with a wheel (or typing) in s / min / h, presets (5 s, 30 s, 1 min, 5 min, 30 min), and the limit shown before it is reached |
| Time of day | two number boxes | the platform's **time picker** (a native one on the phone, `type=time` on the web) |
| Days | two pill rows | **seven round day toggles** (M T W T F S S) on one line; the sentence says "weekdays" (phase 3 dropped the preset row: it did not fit a phone beside them) |
| A choice of 2–3 | pills | a **segmented control**, full width |
| A choice of more | pills that overflow | a **token that opens a list sheet** |
| Comparison | six pills | a token: "is [below ▾]" |
| Part, setting, automation | inline expanding list | a **sheet**, searchable, grouped by device |

### 5. The visual system

Built once in `packages/ui`, used everywhere:

- **Spacing** on a 4 px grid (4, 8, 12, 16, 24, 32); cards 16 px inside on a
  phone, 20 on a tablet; 12 between cards.
- **Type**: one scale — title 28, section 17, body 15, secondary 13, caption
  12; uppercase only for the smallest section labels, if at all.
- **Components**: `Sheet` (bottom sheet, with a handle and a title),
  `TokenText` (a sentence with tappable values), `SegmentedControl` that
  wraps or becomes a sheet, `DurationField`, `TimeField`, `DayPicker`,
  `StepCard`, `ListRow`, `StatusLine`, `ActionMenu`.
- **Alignment, by construction**: an icon is a square box of its size with
  its line height equal to it, so the glyph is centred in it; an icon beside
  a label is one component (`IconLabel`) that centres the icon on the
  label's first line — no `marginTop` nudges anywhere, and the thirteen there
  are go. Every screen has one left edge (16 px on a phone): labels, cards,
  and the rail of nested steps start on it or on the 4 px grid inside it.
- **Colour**: the green accent for the one primary action and "on"; red only
  inside a confirmation; status colours (running, failed, watching) shared
  with the home page.
- **Motion**: sheets slide, cards fold, a running step's progress moves — and
  all of it off when the system asks for reduced motion.

### 6. Words

- **Sentences say outcomes**: the charge window reads "Charges Garage P280
  through Laddare: on below 15 %, off at 50 %", not "turn Laddare on if … off
  if not". Where the generated sentence cannot say it better, the recipe's
  own sentence is kept.
- **No stutter**: "Would turn Laddare off · 2 min ago", once.
- **Modes**: *Off · Watch only · Act*, and Run is always "Run" — the screen
  says that a run started by you acts, once, where it matters.

## How it is checked

- **No horizontal overflow, ever**: an e2e check opens the list, an
  automation and the editor (with a condition open) at 320 and 375 px, and
  fails if any element's right edge passes the viewport.
- **Targets**: drawn at 44 × 44 px; the same check fails on any interactive
  element under 40 × 40 px.
- **Alignment**: the same check fails when an icon's centre is more than
  1 px from its label's first line, or a card or section label starts off
  the screen's left edge; and a source check fails on a `marginTop` set on an
  icon.
- **Screenshots** of the list, an automation and the editor at 375 and 1280
  px, light and dark, kept with each phase's commit and looked at before it
  is pushed.
- **Accessibility**: every token and sheet reachable by keyboard and named for
  a screen reader; reordering possible without dragging.
- The e2e flows that exist (copy a recipe, build from nothing, a chain, a
  night window) are kept, rewritten for the new controls.

## Decided with the owner, 2026-10-01

- **Small cards, full width**: what starts it, its name, how it stands, and
  a play button. **The same card** in the list, on the home page, and on a
  device's page.
- **A page per automation**, opened from its card: a view mode, and an edit
  mode — Edit turns the same page editable in place, with a sticky Cancel /
  Save bar (phase 2; until then Edit opens the editor).
- **Groups that cannot be missed**: each part of an automation a bounded box
  with a header; an empty one says so inside its box.
- **On a device's page**, at the bottom: the same list, kept to the
  automations that device takes part in, and New, which starts from that
  device.

The plan in full, with what the owner's review found in the running app (lost
expressions, a broken "when something holds" blank, Enter that does not
submit, invisible text selection, no headings or landmarks), is the plan
these phases follow.

## Phases

Each phase is pushed on its own, green, so it can be tried on the NAS.

**Phase 1 done, 2026-10-01**: the card, the list, the automation's page in
view mode with its groups and ⋯ menu, the device page's list, and the
general fixes — the selection colour, Enter that submits every form,
headings and landmarks (and a back link a keyboard can reach).

**Phase 2 done, 2026-10-01**: Edit turns the automation's page into its form
in place — the same groups, editable, Cancel (asked first when something
changed) and Save kept below the page, and what is wrong said in the group it
is about; a new one is the same form after "Start from". Triggers and "Only
if" read as one line, opened to change. A value worked out as it runs ("on
while the charge is below 50 %") stays a condition, and becoming a fixed
value is asked first. A new "When something holds" starts from a reading the
editor can draw. A part's role is labelled by what it is ("Switch"), never by
a device's name that can change. Started from a device, a new one offers that
device first wherever a part is chosen, and lists the recipes it fits first —
it fills no role by itself: a plug fits both a charger's supply and its plug,
and a guess would be wrong as often as right.

**Phase 3 done, 2026-10-01**: the controls inside the groups. Pills wrap and
never leave the screen (`Chips`, now in `packages/ui`); a condition's kind and
an ordered comparison are lists to pick from. A duration is one 44 px control
— the number, then s / min — with its limit under it ("Longest: 10 min").
A time of day is the browser's own time field. The days are seven round
toggles on one line, with no Weekdays / Weekends row: the sentence above
already says "on weekdays" when that is what they make. A step's Move up,
Move down and Remove sit behind its ⋯. Icons beside words are `IconLabel`
(the icon centred on the first line), and every `marginTop` nudge is gone.
`layout.e2e.ts` checks it at 320 and 375 px: nothing past the screen's edge,
nothing to touch under 40 px (44 is what is drawn; 40 is where the check
fails), no choice's words cut short, no icon more than 1 px off its line.

The review's remaining audits, each done:

- **Device settings.** `ModeRow` was a second copy of `SegmentedControl` that
  cut "1.8 kW" to "1.8 k…" at 375 px and had no name and no keyboard; it is
  gone, and the one control keeps every label whole. It measures itself and
  splits into rows of equal length when its options do not fit at 44 px
  each: at 320 px the P280's six-way "Delay AC charging" is three and three,
  and its five power steps still one line. The device's rename field, its
  Remove and Make preferred buttons, and the ATORCH's buttons and price field
  are 44 px. Sliders keep a 20 px thumb: the whole track is what a finger
  presses.
- **The price service's card.** "0.59 SEK/kWh" left no room for "Price rank
  today", which ran past the card's edge; what is read beside the main
  reading now moves below it when it does not fit (`DeviceCard`, so every
  device's card). Its history's ranges (6h … 1y) were bare text a keyboard
  could not reach; they are a named radio group of 40 px options, and the
  measurements above them are `Chips`.
- **Keyboard through the editor.** Tab follows the page: name, parts,
  triggers, conditions, steps, the two "Add a step" (each named for its
  list: "Add a step: If a step does not succeed"), Cancel, Save — and each
  stop shows the accent ring. Every radio group is one Tab stop: the arrows
  move, Space or Enter chooses (`useRadioGroup` in `packages/ui`, shared by
  `SegmentedControl`, `Chips`, the duration's units and the history's
  ranges). The duration's s / min could be reached but not chosen by
  keyboard; it can now.
- **The list at phone width.** Covered by the layout check, with the home
  page, a price service's page and two devices' settings added to it.

1. **U1 — Fix what is broken (small).** Pill rows that wrap, never
   overflow; a `DurationField` and a native `TimeField`; 44 px targets; step
   actions in a "⋯" menu instead of three icons; Delete into a menu; the
   stuttering last-run line; headers that do not wrap; icons centred by
   `IconLabel`, the nudges gone, one left edge; the overflow, target and
   alignment checks in e2e.
2. **U2 — The list and an automation's screen.** Compact rows with play
   and status; the automation's own screen with Run, the flow, Right now, the
   mode, and Activity; the "⋯" menu.
3. **U3 — The editor as sentences.** `Sheet` and `TokenText`; steps and
   conditions as sentences with tokens; insert points; drag to reorder; the
   sticky bar; problems on the step; nesting that folds.
4. **U4 — Polish.** The recipe gallery as cards ("Start from"), empty
   states, motion and haptics, the words of the generated sentences, light
   mode, tablet and desktop layouts (the editor beside its preview).

## Open for the owner

- A reference to match: is there one app whose automation editor feels
  right — Shortcuts, Home Assistant, Google Home?
- Drag to reorder on the web as well, or the "⋯" menu there?
