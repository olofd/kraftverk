# kraftverk in an AI-first world: the proposition

**Status:** a product proposition, written 2026-09-29 after researching where
Home Assistant stands, what it is trying to become, and what the big platforms
are shipping. [`PRODUCT.md`](PRODUCT.md) says what kraftverk is and the phases
already planned; [`NEXT-STEP-ARCHITECTURE.md`](NEXT-STEP-ARCHITECTURE.md) says
what the code needs next. This document says **why the direction is right for
the world that is coming, where Home Assistant falls short in that world, and
what to emphasise** — in how it is built, how it is executed, and how a
product is built around it. Sources are listed at the end; claims about other
projects are theirs, quoted or paraphrased, and dated.

---

## 1. The world tomorrow, in one page

Five things are true now that were not true when Home Assistant's shape was
decided, and each one changes what a home hub should be.

1. **Code is cheap.** A coding agent can reverse-engineer a device, read a
   register map out of a vendor app and write a working integration in an
   afternoon; the cost of *trying* has collapsed, and so has the psychological
   cost of throwing it away and doing it again. Simon Willison's "reverse-
   engineering is cheap now" (July 2026) is the plainest statement of it, and
   a security researcher using an agent to document and control three
   peripherals from their firmware (August 2026) is the proof. The scarce
   thing is no longer the integration. It is the **rails** that make an
   agent's code safe to run against a €1 000 battery.

2. **The model is the new user.** In 2026 a model acts on people's behalf
   across steps: Gemini for Home, Alexa+ and the rebuilt Siri all pitch
   "assistants that act without you directing each step". The primary caller
   of a home's API in 2028 is not a finger on a dashboard; it is an agent
   holding a goal. An API designed for fingers — flat entities, service
   calls, dashboards you assemble — is the wrong shape for that caller.

3. **Autonomy needs guardrails that are product features, not settings.**
   The safety literature on agents that touch the physical world converges
   on the same list: a policy gate before the model is called, escalation
   on *risk* rather than on every write (confirmation fatigue manufactures
   the appearance of oversight), an evidence pack for each approval,
   approvals that fail closed, and a tamper-evident, reconstructible audit
   trail. Consumer platforms keep these layers as black boxes; the open
   alternative has to expose them.

4. **Standards are plumbing, not experience.** Matter 1.4 and 1.5 fixed
   technical interoperability and left users with "fragmented suburbs":
   platforms adopt spec versions at different speeds, multi-admin desyncs,
   cameras and vacuums arrive with the basics only, and you still need the
   vendor's app for anything the standard cannot say. The floor is real; the
   ceiling is still per product.

5. **Energy is the killer app of the flexible home.** The IEA's 500 GW of
   demand-response capacity by 2030 is mostly buildings and EVs; the
   residential loads that can shift — batteries, chargers, heaters, pumps —
   are exactly the devices with dangerous writes and undocumented protocols.
   Research on agentic home energy management is arriving, and it is mostly
   an LLM in front of an optimiser, in simulation. Nobody has shipped the
   local, safe, device-deep version.

kraftverk was built for a power station that a single wrong write destroys,
by one person with a coding agent, with one gateway every action passes. It
is, almost by accident, the right shape for all five.

---

## 2. Where Home Assistant falls short, honestly

Home Assistant is the best open smart-home platform there is: two million
homes, 21 000 contributors, a foundation with 70 staff, a voice stack that
runs locally, an MCP server, and a public roadmap. Nothing here is a reason
to replace it. It is a list of the places where its *shape* — decided in
2013, for a world where integrations were expensive and the user was a
finger — is now the constraint, and where a hub designed in 2026 can be
better.

### 2.1 The entity is the wrong atom

Home Assistant's own 2025 roadmap says it: devices "appear as disconnected
entities rather than unified appliances… a refrigerator shows as separate
temperature sensors and door switches without context", and the goal is that
"a fridge becomes more than a list of entities — it becomes an actual device
that can have a dedicated dashboard, default automations, and contextual
voice commands". In May 2026 users are still asking, after a year, whether to
target a device or an entity in an automation; the community's standing
advice is "never automate off devices". A naming-convention dispute in March
2026 has "tensions high".

The entity model is why dashboards must be assembled by hand, why automations
"ask you to think like the automation engine and the state model" (Frenck,
June 2026), why an LLM is handed a list, and why every deep device needs a
custom card. Home Assistant is adding context on top of entities; kraftverk
starts from **a device made of parts, with typed attributes that carry
standard meanings, capabilities declared like clusters, and events** — the
model Home Assistant is trying to reach, as the foundation rather than a
layer.

### 2.2 AI is bolted onto a model that was not built for it

Home Assistant's AI is deliberately a *tool, not autonomy*: Assist handles
commands deterministically and only "questions or commands it can't
understand" go to the LLM; AI Task generates data and "Suggest with AI"
names automations. That is a sound, careful position. But the mechanism
underneath is an **entity dump**: every exposed entity is added to every
request, about 1 300 tokens for 30 entities, 12 000+ for a real home; the
official Ollama guidance is "expose fewer than 25 entities"; the popular
local model ships with a warning in capitals that it "MAY OCCASIONALLY
HALLUCINATE AND ISSUE COMMANDS TO THE WRONG DEVICE"; and users report "either
nothing happens or the wrong devices turn on or off". The safety layer
between a model and a device is a per-entity *exposed* checkbox. Generated
automations arrive as YAML that works "in most cases", is non-deterministic,
and must be reviewed by the person it was meant to spare.

What an AI-first hub needs instead:

- **a world model designed to be read by a model**: compact, typed, with
  meanings, a few hundred tokens for a whole home, and *addressable* — a
  part, a capability, a command — rather than a list of names to fuzzy-match;
- **intents, not service calls**: a model proposes `switch.set(on: false)` on
  `outlet.ac` of "Garage station", typed and checked, never a YAML blob;
- **a gateway that treats the model as what it is, an untrusted actor**:
  read-only by default, dwell time, fresh data, confirmation escalated on
  consequence with an evidence pack, verification by reading back, and a
  receipt on a timeline — for a person, an automation and an agent alike;
- **observe before arm**: a proposed behaviour runs as a dry run, says what it
  would have done, and can be *rehearsed against history* before it is
  allowed to act.

kraftverk has the model, the gateway and observe-before-arm today. It has no
model in front of them yet. That is the gap to close, and it is the smaller
half.

### 2.3 Integrations are expensive to write and to keep

A Home Assistant integration is a Python package, a config flow, entity
platforms, a quality scale whose upper tiers "often involve complete
rewrites", and a review queue. Custom integrations — the long tail, the
reverse-engineered devices — are explicitly "not reviewed, security audited,
maintained, or supported"; they break on core deprecations ("with yet another
update, the mechanism of creating entities was broken"); breaking changes
ship monthly and the most-voiced complaint in 2025–2026 is update fatigue.
The foundation's answer is a *device database*: structured, community-
submitted knowledge about devices.

The 2026 answer is different: the knowledge is **code, written by an agent,
kept honest by a contract**. A device type is one TypeScript package with a
simulator, a contract test that tells the agent when it is wrong, an
architecture check that tells it where it is not allowed, and — this is the
part no one else has — the same code running on the server, in a browser and
on a phone. Quality is measured by tests and evidence bundles, not by a
queue. When the contract changes, every package is rebuilt by an agent
against the contract test, in the open, in an afternoon. "Support in an
afternoon" is the pitch; "support before lunch" is where it goes.

### 2.4 Physical safety is a service call

In Home Assistant a risky write is a service call. There is no dwell, no
freshness rule, no read-back, no second proof from a linked device, no
"this cuts mains to the station, confirm", no observe-before-arm — and a
custom integration can do anything the process can. For lights that is fine.
For a battery whose register 68 written zero bricks it, for a relay upstream
of a station's charger, for an EV charger, a heat pump, a valve, it is not.
The research on physical agents says the reflex layer must be deterministic
and cheap, the policy gate must sit *before* the model, and every action must
be reconstructible afterwards. kraftverk's gateway is that gate, and it runs
wherever the connection is held.

### 2.5 Getting in is hard; trying is impossible

"Before you can even use it, you need to set up your own server"; flashing an
OS, static addresses, the device/entity/YAML trinity — Home Assistant's own
2026.8 release is titled "Approachable by design" and removes forty-three
"advanced" labels and the `:8123` port. kraftverk's app runs in a browser
with no server and can hold a Bluetooth device itself; a page on the internet
can *be* the hub for a device in your hand. Nothing in this space can be
tried before it is installed. This one can.

### 2.6 History fills disks

The recorder stores every state change; users report 22 GB databases that
can no longer be backed up and 78 GB purges that take hours; long-term
statistics are hourly means that never expire; the advice is to exclude noisy
entities by hand. kraftverk records what a description says to keep, at a
minute, rolls up to hours for two years, and (planned) keeps a state-change
log for booleans and enums that is small and exact. History as a designed
thing, not a side effect.

### 2.7 Where Home Assistant is strong, and kraftverk does not compete

Breadth (thousands of integrations, Zigbee, Z-Wave, Matter, cameras, media),
a voice stack and hardware, a community and a foundation, an installer base.
kraftverk **sits beside it**: every kraftverk device appears in Home
Assistant through MQTT discovery, commands from Home Assistant pass
kraftverk's gateway and land on its timeline, and Home Assistant remains the
place for everything else. Stand-alone for people without it; a good
neighbour for everyone else. That was the right call in `PRODUCT.md` and
this research strengthens it.

---

## 3. The proposition

> **kraftverk is the home hub built for the age of agents: every device gets
> first-class support written as code — by you or by an agent — on a model a
> model can read, behind one gateway that makes any actor safe, with a
> receipt for everything that happens. Local, honest, and safe with hardware
> that can break.**

Three promises, each checkable:

1. **Every device, first class, in an afternoon.** A package per product,
   with its own pages, settings, rules and evidence; an agent can write it,
   the contract test tells it when it is wrong, and the same code runs in the
   server, the browser and the phone.
2. **Any actor, one gateway.** A tap, an automation, a bridge and a model all
   go through the same rules: read-only until allowed, fresh data, dwell,
   confirmation on consequence, verification by reading back, a receipt.
   "A rule has no more power than you do" extends to "an agent has no more
   power than you do".
3. **A home that explains itself.** Pages drawn from what a device is, not
   dashboards you build; a timeline that answers *why is the heater off*;
   proposals that rehearse before they act; a world model small enough for a
   local model to hold.

And three things it will still not be: a dashboard editor, a scripting
language, or a thousand cloud integrations.

---

## 4. What it feels like: the experience, ahead of the code

These are the product moments the model makes possible. Each names the model
feature it rests on, so they are proposals rather than dreams.

**Ask the house.** "Why is the garage station on battery?" — the answer comes
from the timeline and the links: *the heater plug that feeds it was switched
off at 07:00 by the automation "Sunny heater", because today looked sunny;
the station saw mains go at 07:00:04 and confirmed it.* Rests on: receipts
(§5.1), links between parts, events.

**Propose, rehearse, arm.** "Keep the station above 30 % from the grid, but
let solar do the work on sunny days." The assistant does not write YAML. It
composes a **plan** from typed recipes and intents, shows it as a sentence and
a diagram, and offers a rehearsal: *over the last 30 days this would have
switched 14 times, been refused twice for stale data, and never crossed the
hard floor.* You arm it; it observes for a week and shows what it would have
done; then it acts. Rests on: recipes as data, observe-before-arm, history.

**A receipt for everything.** Every physical action — a tap, an automation,
Home Assistant, an agent — produces a receipt: who, why, the reading before,
the command, the readback, the linked device's evidence, verified or not. The
receipt is what the confirmation dialog shows *before*, and what the timeline
shows *after*. Rests on: the gateway's audit, made first-class.

**Support before lunch.** You plug in a device nobody supports. The app
captures what it can see (advertisements, broadcasts, frames); you hand the
capture to an agent with `AGENTS.md`; it writes the package against the
contract, the simulator replays the capture, the contract test passes, the
evidence bundle attaches, and the package shows the support level it has
earned. Rests on: the recording tool, the contract suite, the workbench made
generic.

**Your phone is the hub.** At the cabin with no server, the app holds the
station over Bluetooth, runs the same package, applies the same gateway, and
syncs history and receipts when it next sees the server. Rests on: the holder
core, which exists.

**The house as a battery.** Solar, a station, a charger plug, prices, a
forecast: one energy view for any set of devices with energy roles, a reserve
controller that watches before it acts, and — later — a plan that shifts
loads against tomorrow's price and cloud cover, locally. Rests on: part roles,
standard meanings, links, recipes.

**Nothing leaves the house unless you say so.** Local by default; a local
model fits because the world model is small; a cloud model is a choice per
home, per actor, per device.

---

## 5. How it is built: what to emphasise in the framework

The architecture is right. These are the emphases that make it AI-first
rather than AI-compatible. Each maps onto a phase in
`NEXT-STEP-ARCHITECTURE.md` §10 where one exists.

### 5.1 The model is the AI contract

Treat the device model as the interface a model reads, and design for that
reader:

- **A world snapshot** — `GET /api/world` — that renders every device as a
  few lines: name, parts, the capabilities each offers, the current value of
  each primary attribute with its meaning and freshness, links, and the
  actor's permissions. Typed, compact, stable ordering, a few hundred tokens
  for a home. This is what an MCP server exposes, not entities.
- **Intents as the only verbs.** `command(device, part, capability, command,
  args)`, `write(device, patch)`, `query(...)`, `propose(plan)`. No free-form
  service calls. The gateway validates every argument against the value
  system, so a hallucinated argument is a refusal with a sentence, never a
  wrong device.
- **Receipts as data**: every audit entry gets `resourceKind`, `actor`
  (person, automation, bridge, agent, with an id), the intent, the evidence
  before and after, the verdict — and a stable id, so a receipt can be
  referenced, shown, and explained. (Phases 1–3.)
- **Consequence declared, not hard-coded**: capabilities and link kinds
  declare what makes a command consequential (§4.3 there), so an agent's
  policy can be "safe commands without asking; consequential ones with a
  preview; dangerous writes never". (Phase 1.)
- **Structured answers and tools as data** (§4.1, §4.9 there): a query's
  answer and a tool's input are value-typed, so a model can call the
  workbench too — a register dump, a datapoint scan — through the same
  contract. (Phase 1.)

### 5.2 The gateway is the policy gate for every actor

Add the actor kind `agent` beside `user`, `automation` and `home-assistant`,
with a **policy per home**: which capabilities an agent may command without
confirmation, which need a person, which are never allowed; a budget (at
most N consequential actions an hour); and fail-closed approvals with an
expiry. Confirmation becomes a nonce bound to the intent (J17), the dialog
shows the receipt-to-be, and an approval that times out refuses. Every
refusal is a sentence a model can read and act on ("stale reading: ask again
in 20 s"). This is the safety case the physical-agent literature asks for,
and it costs a policy table and one enum. (Phase 3.)

### 5.3 Recipes are plans a model composes

Keep recipes as typed, declarative behaviours with roles, parameters and a
sentence — and make them the *only* thing an assistant can create. A "plan"
is a recipe instance plus bindings; the assistant chooses recipes, fills
roles from the world snapshot, sets parameters within their declared ranges,
and shows the sentence. Rehearsal runs `decide()` against history. There is
no path from a model to a raw automation, which is exactly why it is safe to
let a model make one. Recipes ship with packages (phase 4), so a device's
own author says what it is for.

### 5.4 Quality by evidence, not by queue

Make the *evidence* first-class: a recording tool that turns a session's
bytes into a fixture; a replaying simulator built from a fixture; a
diagnostics bundle with secrets redacted; a `support` level computed from
what a package can prove (contract test, fixture from real hardware, a
verified-on-hardware attestation), not asserted. The README's device table
and each package's badge are generated from it. This is the mechanism that
lets agent-written packages be trusted at scale. (Phase 7.)

### 5.5 Packages written by agents are the growth loop

`AGENTS.md` for device packages, a skill an agent loads, MCP tools for the
workbench (scan, dump, replay, run the contract), and `npm create
kraftverk-device` that scaffolds a package already passing its test. Measure
**time-to-first-reading** for a new device and drive it down. The product's
moat is not the packages; it is that packages are cheap *and* safe here and
nowhere else.

### 5.6 Standards the floor, packages the ceiling, Home Assistant the bridge

BTHome, Shelly and ESPHome as generic self-describing types; refinement that
lets a package deepen a device a standard found; the Home Assistant MQTT
bridge written from the projections; Matter as a spike behind all of it.
Nothing here changes; the research says it is the right order.

### 5.7 Local models are a first-class target

Because the world snapshot is small and intents are typed, a 7B tool-calling
model on the server, or in the browser, is enough for "switch the heater
plug" and "why is it off". Design prompts, tool names and refusal sentences
to be read by small models; test the assistant against a local model in CI
with the simulators. Cloud models are a per-home choice.

---

## 6. How it is executed: what to emphasise in the work

### 6.1 Order

1. **The model, part 3** (NEXT-STEP phase 1). Everything AI-first rests on a
   model a model can read: part-scoped keys, typed answers and tools,
   declared consequence, links between parts, freshness. Do it while strict
   version 1 makes it cheap.
2. **The engine** (phase 3): the stream, the generic gateway with actor
   policies and confirmation nonces, receipts as data, `GET /api/world`.
3. **The assistant, minimum**: an MCP server over intents and the world
   snapshot; "ask the house" over receipts; propose-and-rehearse for the one
   recipe. Against simulators, with a local model, in CI.
4. **The app on the model** (phase 5): events, about, per-part pages, the
   generic energy flow, the P280 drawn from readings, live.
5. **Evidence and agents** (phase 7): recording, replay, computed support,
   `AGENTS.md`, the skill, packages from outside the repository.
6. **The bridge and the floors**: Home Assistant discovery; BTHome, Shelly,
   ESPHome.
7. **Energy**: the reserve controller as a package recipe; price and forecast
   services; the plan that shifts loads.

### 6.2 What to measure

- **Time-to-first-reading** for a device nobody supports (agent, capture,
  package, contract test): the number the pitch rests on.
- **Verified devices** and **fixtures from real hardware**: the evidence base.
- **Receipts per home per week**, and the share **refused** or
  **unverified**: the safety model working, or not.
- **Tokens per world snapshot** and **intent accuracy with a local model**
  against the simulators: the AI-first claim, measured.
- **Time from clone to first device**, and later **from page to first
  device** with no install.

### 6.3 What not to build

A dashboard editor; a scripting language; a rules engine that accepts YAML
or code from a model; Zigbee and Z-Wave radios; cameras, media, voice
hardware; a cloud that data flows through by default. Each is a product, and
Home Assistant already ships them. Saying no to them is what keeps the model
small enough to be safe.

### 6.4 How the work is done

The repository already works the way the proposition says the world works:
one person with agents, a contract, a check on every push, strict version 1.
Keep that. Write the assistant with the same rails it will offer: every
change to the SDK is made everywhere at once, every package is regenerated
against the contract test, and the checks stay green. Publish the
`AGENTS.md` that the project itself uses; it is part of the product.

---

## 7. How a product is built around it

### 7.1 Positioning

*For people whose most important devices are the ones no platform supports
well — batteries, solar, chargers, reverse-engineered gear, things they built
— kraftverk is the local hub that gives each one first-class support written
as code, keeps every action safe and explained, and shows them in Home
Assistant too.*

Three audiences, in the order they will arrive:

1. **Home Assistant users with a power station** (or a BMS, a charger, an odd
   plug): install beside it, see the device deeply, see it in Home Assistant
   anyway. The bridge is the acquisition channel.
2. **People bringing up hardware with an agent**: the workbench, the contract,
   the evidence path. The growth loop.
3. **People who want a safe assistant for the physical parts of their home**:
   the gateway, receipts, propose-and-rehearse. The differentiator once 1 and
   2 have made the device base real.

### 7.2 Distribution

- Published multi-arch images; a Home Assistant add-on repository (how
  Home Assistant OS users install anything); a `compose.yaml` that pulls.
- **Try it now**: the app on a static page, local mode, simulators, and a
  real device over Web Bluetooth from the page. The demo nobody else can do.
- The device index on the site, generated from packages, with computed
  support and the evidence behind it.
- The Home Assistant bridge, so the first thing a Home Assistant user sees
  after installing is their device, correctly classed, in the app they
  already use.

### 7.3 Community and contribution

- **Device bounties and evidence badges**: "a register dump from a P210 is
  worth a lot" becomes a mechanism — an issue template that asks for a
  capture, a badge that the package earns when the fixture lands.
- **Packages outside the repository** from day one of phase 7, so a
  contributor never needs a fork and a maintainer never needs a queue: the
  contract test and the evidence level are the review.
- `AGENTS.md` and the skill as public documents: the project's way of working
  is its onboarding.

### 7.4 Sustainability

Open source, MIT, no cloud in the data path. The honest options for paying
for it, none of which compromise the proposition:

- **Hosted relay and notifications** (remote access without opening ports,
  web push, ntfy): the one thing a local hub genuinely cannot do alone, sold
  as a subscription, with the local path always free — Nabu Casa's model,
  which the research shows funds seventy people without investors.
- **Verified hardware**: a kit or a reference device (a pre-flashed plug, a
  BMS board) that ships with a verified package.
- **Evidence services**: hardware-in-the-loop verification for
  manufacturers who want their device's package marked verified.

Nothing is sold that makes the local, free path worse.

### 7.5 Risks, and what answers them

| Risk | Answer |
|---|---|
| Home Assistant ships device context, default dashboards and a device database first | Their model stays entity-first with context on top; kraftverk's is device-first from the ground, and its integrations are code plus evidence rather than data. Be the neighbour they bridge to, not the rival they replace. |
| The big platforms make agents good enough that nobody wants a local one | Their guardrails are black boxes and their smartest tiers are subscriptions; the flexible-load devices are the ones they do not support. The safe, local, deep niche is theirs to ignore. |
| One person, one verified device | The growth loop is designed for agents; the first three reference devices across transports are the priority, and evidence badges make the second contributor's work trusted. |
| Agent-written packages are wrong in ways tests miss | Computed support levels, fixtures from real hardware, read-only by default, and the gateway: a wrong package can be *inaccurate*; it cannot be *dangerous* without a person saying yes. |
| The model gets too big to be read by a small model | Measure tokens per snapshot in CI; keep capabilities and meanings curated; keep saying no (§6.3). |

---

## 8. The sentence

Home Assistant made the smart home configurable for a world where code was
expensive. kraftverk makes it **describable** for a world where code is
cheap and the caller is a model: every device a package, every action a
receipt, every actor behind one gate, every home its own.

---

## Sources

Home Assistant and the Open Home Foundation:
- [Building the AI-powered local smart home (2025-09-11)](https://www.home-assistant.io/blog/2025/09/11/ai-in-home-assistant/)
- [Roadmap 2025: A Truly Smart Home through Collective Intelligence (2025-05-09)](https://www.home-assistant.io/blog/2025/05/09/roadmap-2025h1/)
- [2025.8: The summer of AI](https://www.home-assistant.io/blog/2025/08/06/release-20258/) · [AI Task](https://www.home-assistant.io/integrations/ai_task/)
- [2026.7: Automations that speak your language](https://www.home-assistant.io/blog/2026/07/01/release-20267/) · [2026.8: Approachable by design](https://www.home-assistant.io/blog/2026/08/05/release-20268/)
- [More power, less complexity in Home Assistant automations (Frenck, 2026-06)](https://frenck.dev/more-power-less-complexity/)
- [Model Context Protocol Server](https://www.home-assistant.io/integrations/mcp_server/) · [Model Context Protocol (client)](https://www.home-assistant.io/integrations/mcp/) · [Ollama integration guidance](https://www.home-assistant.io/integrations/ollama/)
- [Do Home Assistant updates break things? (FAQ)](https://www.home-assistant.io/faq/do-updates-break-things/) · [Integration quality scale](https://www.home-assistant.io/docs/quality_scale/)
- [Open Home Foundation roadmap](https://github.com/OpenHomeFoundation/roadmap) · [State of the Open Home 2026 (writeup)](https://www.ajfriesen.com/state-of-the-open-home-2026/) · [State of the Open Home 2025 recap](https://www.home-assistant.io/blog/2025/04/16/state-of-the-open-home-recap/)
- [Who owns Home Assistant (Apollo Automation)](https://apolloautomation.com/blogs/news/who-owns-home-assistant-the-open-home-foundation-nabu-casa-and-apollo-automation-explained)

Community experience:
- ["I am so (breaking) update tired"](https://community.home-assistant.io/t/ive-just-registerd-this-account-to-tell-you-that-i-am-so-breaking-update-tired/905763) · [WTH: check for breaking changes before updating](https://community.home-assistant.io/t/wth-check-for-breaking-changes-before-installing-updates/804514)
- [Entity vs Device (2026-05)](https://community.home-assistant.io/t/entity-vs-device/1010427) · [Entities are not Devices!](https://github.com/home-assistant/home-assistant.io/issues/36610) · [New user observation: device or entity as target](https://github.com/home-assistant/frontend/discussions/17231)
- [New assist with LLM combination, lot of tokens?](https://community.home-assistant.io/t/new-assist-with-llm-combination-lot-of-tokens/736566) · [Ollama context size must be configurable](https://github.com/home-assistant/core/issues/119946) · [home-llm setup notes](https://github.com/acon96/home-llm/blob/develop/docs/Setup.md) · [home-3b model warning](https://ollama.com/fixt/home-3b-v2) · [mcp-assist: dynamic discovery instead of entity dumps](https://github.com/mike-nott/mcp-assist)
- [4 uncomfortable truths about Home Assistant (How-To Geek)](https://tech.yahoo.com/home/articles/4-uncomfortable-truths-home-assistant-120114057.html) · [Is Home Assistant too complicated for non-tech homeowners?](https://laymansmarthome.com/blog/is-home-assistant-too-complicated-for-non-tech-homeowners)
- [DB size and long-term statistics](https://community.home-assistant.io/t/db-size-and-long-term-statistics/789637) · [Why is your Home Assistant database so big?](https://tarahome.ai/blog/home-assistant-database-too-large-recorder-purge/) · [Recorder](https://www.home-assistant.io/integrations/recorder/)
- [AI Automation Builder](https://community.home-assistant.io/t/ai-automation-builder-natural-language-to-valid-ha-automations-with-free-ia/975793) · [AI Agent HA](https://community.home-assistant.io/t/introducing-ai-agent-ha-create-automations-dashboards-with-just-plain-english-with-ai-agent/906799) · [homeassistant-ai toolkit](https://github.com/homeassistant-ai)

Agents, safety and research:
- [Reverse-engineering is cheap now (Simon Willison, 2026-07-20)](https://simonwillison.net/2026/Jul/20/cheap-reverse-engineering/) · [AI agents reverse-engineer hardware peripherals (2026-08)](https://aitoolly.com/ai-news/article/2026-08-24-ai-driven-hardware-exploitation-researcher-uses-ai-agents-to-reverse-engineer-and-control-peripheral)
- [The agentic AI safety case for physical security (2026)](https://intellisee.com/intelligence/agentic-ai-safety-case-physical-security-2026-autonomy-tiers-failure-modes-operational-guardrails/) · [The "read-only" safety protocol for industrial IoT](https://www.iotforall.com/agentic-ai-physical-world-read-only-safety) · [How to build an AI agent audit log](https://www.agentguard.one/guides/how-to-build-ai-agent-audit-log/) · [The 2026 Singapore Consensus on AI safety research priorities](https://arxiv.org/pdf/2608.14611)
- [IoTGPT: LLMs for efficient and personalized smart home automation (2026-01)](https://arxiv.org/html/2601.04680v1) · [Generating Home Assistant automations using an LLM-based chatbot](https://pith.science/paper/2505.02802) · [HomeBench](https://arxiv.org/pdf/2505.19628) · [HearthNet: edge multi-agent orchestration for smart homes](https://arxiv.org/pdf/2604.09618)
- [Agentic AI home energy management (2025-10)](https://arxiv.org/html/2510.26603v1) · [LLMs for agentic home energy management (2026-07)](https://arxiv.org/pdf/2607.04569) · [The Intelligent Home: a systematic review (MDPI, 2026)](https://www.mdpi.com/2073-8994/18/5/718)

Platforms and standards:
- [Matter promised to fix smart homes, but created a worse mess instead (XDA, 2026-04)](https://www.xda-developers.com/why-matter-isnt-the-smart-home-savior-we-were-promised-yet/) · [Matter promised smart home unity, 3 years later it's still a fragmented mess (How-To Geek, 2025-10)](https://www.howtogeek.com/matter-promised-smart-home-unity-years-later-its-still-a-fragmented-mess/)
- [Gemini for Home vs Alexa+ vs Siri (2026)](https://smartifiers.com/articles/ai-home-assistants-2026-gemini-vs-alexa-plus-vs-siri/) · [Alexa+ vs Gemini vs Apple Intelligence 2026](https://www.smarthomeexplorer.com/guides/alexa-plus-vs-google-gemini-home-vs-apple-intelligence-2026) · [Voice assistants find their next act (eMarketer)](https://www.emarketer.com/content/voice-assistants-find-their-next-act-preferred-interface-ai-first-homes)
