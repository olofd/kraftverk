# The assistant's data model — a plan

**Status:** a plan, 2026-10-09. Nothing here is built. It is the first
step of [PLAN-AI.md](PLAN-AI.md), whose §4.1 sketched the tables; this
document is that sketch made whole: every table, every rule the database
holds, how two people share one assistant, what history is kept and how
long, how memory is written and recalled, and the order the model is built
in — before any model is called.

Written in the store's own style (`packages/store/src/schema.ts`): one
schema, no migrations, every column required that can be, a null kept only
where it means something; ids a prefix and a ULID; who did something an
actor as it was called then.

## 1. What the model must hold

1. **Conversations between people and an assistant.** One person alone
   with it; **two or more people and one assistant** together — Anna and
   Erik planning the week, the assistant answering either; people alone,
   with no assistant, as a family's own chat.
2. **Who is in a conversation, and since when.** A person added later
   sees what the conversation chose to show them; a person who leaves reads
   no more; what each said stays theirs.
3. **What people saw, and what the model was told**, kept apart: the
   messages are the conversation; the turns, the model's calls and the
   tools it used are the trace behind each answer.
4. **History**: every conversation readable and searchable later, by the
   people who were in it; long conversations summarised so they can be
   carried on; what the assistant did leading to the timeline and back.
5. **Memory and recall**: what the assistant knows about the family and
   each person — said by a person, theirs to see, correct and forget —
   recalled when it matters, and never to someone it is not for.
6. **Acting**: on whose authority each answer acts; the yes it asks of a
   person; what it did.
7. **Errands**: goals with an end, the grant a person gave, what the
   errand set up, when it wakes, what it spent.
8. **Models**: the providers and models a family uses, where each runs,
   which does what, the models kraftverk downloaded, and what it all cost.
9. **Rules for agents** per home, budgets, and tokens for agents from
   outside.
10. **Privacy and erasure**: who may read what; a person erased leaves no
    words behind; nothing kept longer than it says.
11. **Everywhere a home runs**: the server, the browser and the phone —
    the same schema on SQLite in all three.

## 2. The rules the model keeps

1. **A conversation is the people in it.** Membership is kept as spans of
   the conversation's messages; whether a person may read message *n* is a
   fact the database answers, not a filter remembered by a screen.
2. **Who asked decides what is done; everyone present decides what is
   said.** An answer acts on the authority of the person whose message it
   answers. What it reads, recalls and says is held to what **every person
   who will read it** may know — the conversation's *audience*.
3. **What people see and what the model was told are kept apart.**
   Messages are kept as long as the conversation; traces for a month.
4. **A memory rests on a person's words.** Every memory names the person
   whose words it rests on and the message they said them in. Nothing read
   by a tool — a device's name, a web page, a vendor's data — becomes a
   memory.
5. **Every act leads back.** A tool's call names the timeline entry it
   made; the entry names the turn; the turn names its conversation.
6. **What is kept says how long** (§6.5). Audio is never kept.
9. **Privacy is the family's to set; its guarantee is kraftverk's.** Every
   privacy and security choice is a setting with a default (§8.1); the
   strictest that applies holds, enforced where the data is, and a reset
   never loosens one.
7. **The database holds what it can** — membership, one turn at a time,
   an author for every message, a source for every memory — and the hub
   the rest, as everywhere in kraftverk.
8. **The family's database, written by its master** — a server, or the
   app that keeps the family itself — as every other table is.

## 3. The tables at a glance

```
 assistant ─┬─ assistant_person (each person's own settings)
            ├─ model_role ── model ── model_provider ── model_provider_secret
            │                  └── local_model (downloaded into kraftverk's own service)
            └─ agent_rule (per home: free · asks · never)

 conversation ─┬─ conversation_person (now: role, read, notify) ── person
               ├─ conversation_span   (who could read which messages)
               ├─ message ── message_fts, message_feedback
               ├─ conversation_digest ── digest_vector, digest_fts
               └─ turn ─┬─ turn_step ── audit (what it did) · ask
                        └─ turn_recall (what it remembered, and why)

 ask ── notification (Yes / No)          errand ─┬─ errand_grant
                                                 ├─ errand_wake
 memory ─┬─ memory_person                        └─ errand_automation ── automation
         ├─ memory_vector
         └─ memory_fts                    model_usage (per day)

 privacy_setting (family · home · person · conversation)

 node.db: agent_token
```

| Thing | Prefix | Kept in |
| --- | --- | --- |
| Assistant | `as-` | the family's database |
| Model provider | `mp-` | the family's |
| Model | `mo-` | the family's |
| Downloaded model | `lm-` | the family's |
| Conversation | `cv-` | the family's |
| Message | `mg-` | the family's |
| Turn | `tu-` | the family's |
| Ask | `ak-` | the family's |
| Errand | `er-` | the family's |
| Wake | `ew-` | the family's |
| Memory | `me-` | the family's |
| Digest | `dg-` | the family's |
| Agent rule | `ar-` | the family's |
| Agent token | `at-` | a node's (`node.db`) |

## 4. The tables

### 4.1 The assistant, and each person's own settings

```sql
/*
  An assistant of the family: what it is called and answers to, how it
  speaks, what the family tells it. One to begin with; another when a family
  wants one of another kind — a builder, a child's. What it may do is never
  its own: each turn acts for a person, with their role, under the home's
  rules for agents (agent_rule) and its own limits here.
*/
CREATE TABLE assistant (
  id               TEXT PRIMARY KEY CHECK (id GLOB 'as-*'),
  /* Its name in configuration, as an automation's key is. */
  key              TEXT NOT NULL UNIQUE CHECK (key GLOB '[a-z0-9]*' AND key NOT GLOB '*[^a-z0-9-]*' AND length(key) <= 63),
  /* What it is called, and answers to by voice and in a group: "Kraft". */
  name             TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 30),
  /* How it speaks, as data the words and the voice read (PLAN-AI.md §4.11): its register, a paragraph of style, and its voice per engine. */
  persona          TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(persona)),
  /* The family's own words to it, kept whole: "Answer in Swedish. Never start the dryer after 22:00 without asking." */
  instructions     TEXT NOT NULL DEFAULT '' CHECK (length(instructions) <= 4000),
  /* BCP 47: what it speaks unless spoken to in another; null: the family's. */
  locale           TEXT,
  /* What it may spend in a day: tokens, and money in millionths of a US dollar, as providers price them; null: no limit. */
  day_tokens       INTEGER CHECK (day_tokens > 0),
  day_cost_micros  INTEGER CHECK (day_cost_micros > 0),
  /* Consequential acts in an hour, for every person it acts for together: the gateway's dwell beside it. */
  acts_per_hour    INTEGER NOT NULL DEFAULT 10 CHECK (acts_per_hour BETWEEN 0 AND 1000),
  /* The one a new conversation is with, unless another is chosen. */
  is_default       INTEGER NOT NULL CHECK (is_default IN (0, 1)),
  created_at       TEXT NOT NULL,
  created_by       TEXT NOT NULL REFERENCES person (id),
  /* Stopped: no turn of it runs, no errand of it wakes, until started again. The stop every family needs one tap from. */
  stopped_at       TEXT,
  stopped_by       TEXT REFERENCES person (id),
  CHECK ((stopped_at IS NULL) = (stopped_by IS NULL))
);
CREATE UNIQUE INDEX assistant_default ON assistant (is_default) WHERE is_default = 1;

/*
  What each person has chosen about an assistant: their own, set by them
  (an admin's for a child they keep). No row: the defaults.
*/
CREATE TABLE assistant_person (
  assistant_id TEXT NOT NULL REFERENCES assistant (id) ON DELETE CASCADE,
  person_id    TEXT NOT NULL REFERENCES person (id),
  /* Whether its answers to them are spoken aloud unless they say otherwise. */
  speaks       INTEGER NOT NULL DEFAULT 0 CHECK (speaks IN (0, 1)),
  /* BCP 47: the language they talk to it in; null: their own. */
  locale       TEXT,
  /* What they are told of: every message in their conversations, only what is said to them and asks, or asks alone. */
  notify       TEXT NOT NULL DEFAULT 'mentions' CHECK (notify IN ('all', 'mentions', 'asks')),
  changed_at   TEXT NOT NULL,
  PRIMARY KEY (assistant_id, person_id)
);
```

### 4.2 Models: providers, models, roles, downloads

```sql
/*
  Where models are reached (PLAN-AI.md §4.7): an address that speaks one
  wire protocol — kraftverk's own models service, an Ollama, OpenRouter,
  Anthropic — or the phone's own model. Where it runs is checked, not
  assumed (PLAN-AI.md §4.14), and kept as last checked.
*/
CREATE TABLE model_provider (
  id          TEXT PRIMARY KEY CHECK (id GLOB 'mp-*'),
  label       TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 60),
  /* Which kind it was set up as: what Settings showed, and what it manages (pulling models from an Ollama). */
  preset      TEXT NOT NULL CHECK (preset IN ('kraftverk', 'ollama', 'llama-cpp', 'lm-studio', 'openrouter', 'anthropic', 'openai', 'google', 'apple', 'custom')),
  protocol    TEXT NOT NULL CHECK (protocol IN ('openai-chat', 'anthropic-messages', 'openai-responses', 'gemini', 'on-device')),
  /* Its base address; null for a model on the phone itself. */
  address     TEXT CHECK (address IS NULL OR address GLOB 'http*://*'),
  /* Where it runs: in this house and shut in (kraftverk's own service); on the home's network; in the cloud; on the device that calls it. */
  runs        TEXT NOT NULL CHECK (runs IN ('sealed', 'network', 'cloud', 'device')),
  checked_at  TEXT,
  /* The node that calls it: the server, or the phone whose own model it is. */
  held_by     TEXT NOT NULL REFERENCES node (id) ON DELETE CASCADE,
  /* The preset's own: OpenRouter's zero retention, a session to keep its cache, fallbacks. */
  options     TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(options)),
  created_at  TEXT NOT NULL,
  created_by  TEXT NOT NULL REFERENCES person (id),
  CHECK ((protocol = 'on-device') = (address IS NULL)),
  CHECK ((protocol = 'on-device') = (runs = 'device'))
);

/* Its key, sealed, held by the node that calls it — as connection_secret is. */
CREATE TABLE model_provider_secret (
  provider_id TEXT PRIMARY KEY REFERENCES model_provider (id) ON DELETE CASCADE,
  value       TEXT NOT NULL,
  encrypted   INTEGER NOT NULL CHECK (encrypted IN (0, 1)),
  written_at  TEXT NOT NULL
);

/*
  A model a provider offers, as the family uses it: its name there, what it
  is for, what it can do (as probed), and what it costs. A provider has many;
  an Ollama has every model pulled into it.
*/
CREATE TABLE model (
  id           TEXT PRIMARY KEY CHECK (id GLOB 'mo-*'),
  provider_id  TEXT NOT NULL REFERENCES model_provider (id) ON DELETE CASCADE,
  /* Its name at the provider: "gemma4:26b", "claude-…". */
  name         TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  kind         TEXT NOT NULL CHECK (kind IN ('language', 'embedding', 'speech-to-text', 'text-to-speech')),
  /* What it can do, as probed: tools, several at once, strict schemas, a grammar, a cache, thinking, pictures, its context, how many tools before it gets worse. */
  abilities    TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(abilities)),
  /* Per million tokens, in millionths of a dollar: { input, cached, output }; null: free or not known. */
  price        TEXT CHECK (price IS NULL OR json_valid(price)),
  /* For an embedding model: how long its vectors are. */
  dimensions   INTEGER CHECK (dimensions > 0),
  /* What the evals found it good for (PLAN-AI.md §4.17), per role, as last run here: { "voice": { "passed": true, "at": … } }. */
  evaluated    TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(evaluated)),
  probed_at    TEXT,
  UNIQUE (provider_id, name),
  CHECK ((kind = 'embedding') = (dimensions IS NOT NULL))
);

/*
  Which model does which job for an assistant (PLAN-AI.md §4.1): for
  everyone, or a person's own choice for theirs. One row per job and person.
*/
CREATE TABLE model_role (
  assistant_id TEXT NOT NULL REFERENCES assistant (id) ON DELETE CASCADE,
  role         TEXT NOT NULL CHECK (role IN ('chat', 'voice', 'author', 'background', 'step', 'embed', 'listen', 'speak')),
  /* A person's own; null: everyone's. Only 'chat', 'voice', 'listen' and 'speak' are a person's to choose. */
  person_id    TEXT REFERENCES person (id),
  model_id     TEXT NOT NULL REFERENCES model (id) ON DELETE CASCADE,
  set_by       TEXT NOT NULL REFERENCES person (id),
  set_at       TEXT NOT NULL,
  CHECK (person_id IS NULL OR role IN ('chat', 'voice', 'listen', 'speak'))
);
CREATE UNIQUE INDEX model_role_once ON model_role (assistant_id, role, coalesce(person_id, ''));

/*
  A model kraftverk downloaded into its own models service (PLAN-AI.md
  §4.7): the catalogue's entry, the file and its hash, how far along, and
  which roles it passed the self-test for on this hardware.
*/
CREATE TABLE local_model (
  id          TEXT PRIMARY KEY CHECK (id GLOB 'lm-*'),
  /* The catalogue's key: "gemma4-26b-a4b-q4km". */
  entry       TEXT NOT NULL UNIQUE,
  file        TEXT NOT NULL,
  sha256      TEXT NOT NULL CHECK (length(sha256) = 64),
  bytes       INTEGER NOT NULL CHECK (bytes > 0),
  state       TEXT NOT NULL CHECK (state IN ('downloading', 'checking', 'ready', 'failed')),
  /* Bytes down so far, while downloading. */
  done        INTEGER NOT NULL DEFAULT 0 CHECK (done >= 0),
  /* The roles it passed the self-test for here: ["voice", "step"]. */
  passed      TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(passed)),
  /* The model row it is served as, once loaded. */
  model_id    TEXT REFERENCES model (id) ON DELETE SET NULL,
  asked_by    TEXT NOT NULL REFERENCES person (id),
  asked_at    TEXT NOT NULL,
  ready_at    TEXT,
  why         TEXT,
  CHECK ((state = 'ready') = (ready_at IS NOT NULL)),
  CHECK ((state = 'failed') = (why IS NOT NULL))
);
```

### 4.3 Conversations, and who is in them

```sql
/*
  A conversation: people, and at most one assistant, writing to each other
  (§5). Its messages are numbered from 1 with no gaps; who may read which is
  kept in conversation_span. Gone when its last person has left, and with it
  everything kept of it.
*/
CREATE TABLE conversation (
  id            TEXT PRIMARY KEY CHECK (id GLOB 'cv-*'),
  /* Given by a person, or written by the assistant from what it is about; null: none yet. */
  title         TEXT CHECK (length(title) BETWEEN 1 AND 80),
  titled_by     TEXT CHECK (titled_by IN ('person', 'assistant')),
  /* The assistant in it; null: people only. */
  assistant_id  TEXT REFERENCES assistant (id),
  /* When the assistant answers: every message (a person alone with it), or only what is said to it (people together). */
  answers       TEXT NOT NULL CHECK (answers IN ('always', 'addressed')),
  /* The home it is about, unless a message says another; null: the one each person is in, or the family's first. */
  home_id       TEXT REFERENCES home (id),
  /* How it began. */
  origin        TEXT NOT NULL CHECK (origin IN ('app', 'voice', 'errand', 'automation')),
  created_at    TEXT NOT NULL,
  created_by    TEXT NOT NULL REFERENCES person (id),
  /* Its last message's number, and when: what lists sort by, and the next number. */
  last_seq      INTEGER NOT NULL DEFAULT 0 CHECK (last_seq >= 0),
  last_at       TEXT NOT NULL,
  CHECK ((title IS NULL) = (titled_by IS NULL)),
  CHECK (assistant_id IS NOT NULL OR answers = 'addressed')
);

/*
  A person in a conversation, now: their part in it and their own settings.
  One row a person, kept when they leave (left_at), so a conversation knows
  who was in it; what they could read, and when, is conversation_span's.
*/
CREATE TABLE conversation_person (
  conversation_id TEXT NOT NULL REFERENCES conversation (id) ON DELETE CASCADE,
  person_id       TEXT NOT NULL REFERENCES person (id),
  /* An owner may add and remove people, rename it, and take back what anyone shows from before they joined; every conversation has one while anyone is in it. */
  role            TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  joined_at       TEXT NOT NULL,
  added_by        TEXT NOT NULL REFERENCES person (id),
  left_at         TEXT,
  /* The last message they have read. */
  read_seq        INTEGER NOT NULL DEFAULT 0 CHECK (read_seq >= 0),
  /* Their own: kept at the top, put away, told of what. */
  pinned          INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  archived_at     TEXT,
  notify          TEXT NOT NULL DEFAULT 'mentions' CHECK (notify IN ('all', 'mentions', 'none')),
  PRIMARY KEY (conversation_id, person_id)
);
CREATE INDEX conversation_person_now ON conversation_person (person_id) WHERE left_at IS NULL;

/*
  Which messages a person could read: from one number to another (to_seq
  null: still in it). Added with the history, from 1; added without, from
  the next; left, closed; back again, a new span. What history search,
  recall and every list ask: a person reads message n of a conversation when
  a span of theirs holds n.
*/
CREATE TABLE conversation_span (
  conversation_id TEXT NOT NULL REFERENCES conversation (id) ON DELETE CASCADE,
  person_id       TEXT NOT NULL REFERENCES person (id),
  from_seq        INTEGER NOT NULL CHECK (from_seq >= 1),
  to_seq          INTEGER CHECK (to_seq IS NULL OR to_seq >= from_seq - 1),
  PRIMARY KEY (conversation_id, person_id, from_seq)
);
/* One open span a person, at most. */
CREATE UNIQUE INDEX conversation_span_open ON conversation_span (conversation_id, person_id) WHERE to_seq IS NULL;
```

`to_seq >= from_seq - 1` lets a span be empty: a person added and gone before
anything was said read nothing.

### 4.4 Messages

```sql
/*
  What was said in a conversation, in order: by a person, by the assistant,
  or by kraftverk itself ("Erik joined", "The errand is done"). Its parts
  are what it shows — words, a picture, a device's card, a draft, an ask —
  and its text what it says in words: what is searched, read aloud and given
  to a model. Taken back by its author, its words go and its place stays.
*/
CREATE TABLE message (
  id              TEXT PRIMARY KEY CHECK (id GLOB 'mg-*'),
  conversation_id TEXT NOT NULL REFERENCES conversation (id) ON DELETE CASCADE,
  seq             INTEGER NOT NULL CHECK (seq >= 1),
  author          TEXT NOT NULL CHECK (author IN ('person', 'assistant', 'kraftverk')),
  person_id       TEXT REFERENCES person (id),
  assistant_id    TEXT REFERENCES assistant (id),
  /* What it shows, as JSON (§9.1). */
  parts           TEXT NOT NULL CHECK (json_valid(parts)),
  /* What it says in words. */
  text            TEXT NOT NULL CHECK (length(text) <= 32000),
  /* Said to the assistant — by its name, by voice, in reply to it, or in a conversation where it answers always — or to the people. */
  to_assistant    INTEGER NOT NULL CHECK (to_assistant IN (0, 1)),
  via             TEXT NOT NULL CHECK (via IN ('app', 'voice', 'notification', 'errand', 'automation')),
  /* BCP 47: what it is in, when known. */
  locale          TEXT,
  /*
    What the author's app said was around it — the screen (a room, a
    device), the home, the room they were in when they share it — for
    "this room" and "here". The author's and the assistant's: never shown
    to the others.
  */
  context         TEXT CHECK (context IS NULL OR json_valid(context)),
  reply_to        TEXT REFERENCES message (id) ON DELETE SET NULL,
  /* The assistant's: the turn that wrote it. */
  turn_id         TEXT REFERENCES turn (id) ON DELETE SET NULL,
  /* Written whole; still being written (an answer as it streams); stopped part way (spoken over, or stopped) — its text what was shown or heard; failed. */
  state           TEXT NOT NULL CHECK (state IN ('written', 'writing', 'stopped', 'failed')),
  /* Read aloud as it was written. */
  spoken          INTEGER NOT NULL DEFAULT 0 CHECK (spoken IN (0, 1)),
  at              TEXT NOT NULL,
  edited_at       TEXT,
  removed_at      TEXT,
  UNIQUE (conversation_id, seq),
  CHECK ((author = 'person') = (person_id IS NOT NULL)),
  CHECK ((author = 'assistant') = (assistant_id IS NOT NULL)),
  CHECK (author <> 'person' OR turn_id IS NULL),
  CHECK (removed_at IS NULL OR (text = '' AND parts = '[]'))
);

/* The words of every message, for history's search: Swedish and English as written, case and accents kept apart from meaning only by the ranking. */
CREATE VIRTUAL TABLE message_fts USING fts5 (text, content = 'message', content_rowid = 'rowid', tokenize = 'unicode61');

/* A person's word on an answer: good or not, and why — what the evals are drawn from. */
CREATE TABLE message_feedback (
  message_id TEXT NOT NULL REFERENCES message (id) ON DELETE CASCADE,
  person_id  TEXT NOT NULL REFERENCES person (id),
  rating     TEXT NOT NULL CHECK (rating IN ('good', 'bad')),
  note       TEXT CHECK (length(note) <= 1000),
  at         TEXT NOT NULL,
  PRIMARY KEY (message_id, person_id)
);
```

The index is kept by triggers on `message` (insert, the text changed,
removed), so a message is searchable the moment it is written and gone from
search the moment it is taken back.

### 4.5 Turns: what the assistant did to answer

```sql
/*
  One time the assistant was woken to answer or to act: by a person's
  message, a person's answer to an ask, an errand's wake, an automation's
  step, or kraftverk's own work (a conversation summarised). On whose
  authority it acted, who it was speaking before, which model, what it was
  told, how it ended and what it cost. One at a time in a conversation;
  messages that come while it runs are what the next one answers.
*/
CREATE TABLE turn (
  id              TEXT PRIMARY KEY CHECK (id GLOB 'tu-*'),
  assistant_id    TEXT NOT NULL REFERENCES assistant (id) ON DELETE CASCADE,
  /* Its conversation; null for an automation's ask: step, which has none. */
  conversation_id TEXT REFERENCES conversation (id) ON DELETE CASCADE,
  cause           TEXT NOT NULL CHECK (cause IN ('message', 'answer', 'errand', 'automation', 'digest')),
  /* The last message it answers: a person's, or a note that an ask was answered. */
  message_id      TEXT REFERENCES message (id) ON DELETE SET NULL,
  errand_id       TEXT REFERENCES errand (id) ON DELETE CASCADE,
  run_id          TEXT REFERENCES automation_run (id) ON DELETE SET NULL,
  /* Whose authority it acts on: the person who asked, who granted the errand, whom the automation acts for; null: nobody's — it may only read (a summary). */
  for_person      TEXT REFERENCES person (id),
  /* The people who would read what it said — its audience (§5.3) — as it was, as JSON: what its reads and recall were held to. */
  audience        TEXT NOT NULL CHECK (json_valid(audience)),
  model_id        TEXT REFERENCES model (id) ON DELETE SET NULL,
  role            TEXT NOT NULL CHECK (role IN ('chat', 'voice', 'author', 'background', 'step')),
  /* A hash of what it was told before the conversation: its instructions, the skills, the tools — which version of the prompt. */
  prompt          TEXT NOT NULL,
  state           TEXT NOT NULL CHECK (state IN ('running', 'done', 'asked', 'failed', 'stopped', 'interrupted', 'over-budget', 'refused')),
  started_at      TEXT NOT NULL,
  ended_at        TEXT,
  input_tokens    INTEGER NOT NULL DEFAULT 0,
  cached_tokens   INTEGER NOT NULL DEFAULT 0,
  output_tokens   INTEGER NOT NULL DEFAULT 0,
  cost_micros     INTEGER NOT NULL DEFAULT 0,
  /* Why it failed, stopped or was refused, in words. */
  why             TEXT,
  CHECK ((ended_at IS NULL) = (state = 'running')),
  CHECK ((cause = 'automation') = (conversation_id IS NULL)),
  CHECK ((cause = 'errand') = (errand_id IS NOT NULL)),
  CHECK (cause <> 'automation' OR run_id IS NOT NULL OR ended_at IS NOT NULL)
);
CREATE UNIQUE INDEX turn_one_at_a_time ON turn (conversation_id) WHERE ended_at IS NULL AND conversation_id IS NOT NULL;
CREATE INDEX turn_conversation ON turn (conversation_id, started_at);
CREATE INDEX turn_errand ON turn (errand_id, started_at) WHERE errand_id IS NOT NULL;

/*
  A turn's trace, in order: each call to the model — what it answered,
  normalised, and its own state handed back as it came — each tool it used
  and how that came out, each recall, each compaction. Kept a month (§6.5);
  what it did stays on the timeline, whose entry it names.
*/
CREATE TABLE turn_step (
  turn_id        TEXT NOT NULL REFERENCES turn (id) ON DELETE CASCADE,
  n              INTEGER NOT NULL CHECK (n >= 1),
  kind           TEXT NOT NULL CHECK (kind IN ('model', 'tool', 'recall', 'compact')),
  /* A model's answer (its text and its calls) or a tool's arguments and answer, as JSON; a tool's answer cut at 16 KB, its size kept. */
  content        TEXT NOT NULL CHECK (json_valid(content)),
  /* The provider's own state — thinking and its signature, encrypted reasoning — handed back on the next call, and let go a day after. */
  provider_state TEXT,
  tool           TEXT,
  outcome        TEXT CHECK (outcome IN ('ok', 'refused', 'needs-yes', 'failed')),
  /* What it did, on the timeline. */
  audit_id       INTEGER REFERENCES audit (id) ON DELETE SET NULL,
  ask_id         TEXT REFERENCES ask (id) ON DELETE SET NULL,
  input_tokens   INTEGER NOT NULL DEFAULT 0,
  output_tokens  INTEGER NOT NULL DEFAULT 0,
  ms             INTEGER NOT NULL CHECK (ms >= 0),
  at             TEXT NOT NULL,
  PRIMARY KEY (turn_id, n),
  CHECK ((kind = 'tool') = (tool IS NOT NULL)),
  CHECK ((kind = 'tool') = (outcome IS NOT NULL))
);

/*
  What a turn remembered, and why: each memory, summary or earlier message
  recall brought into it, with its score. What "why did you say that?"
  shows, and what the memory page says a memory was used for.
*/
CREATE TABLE turn_recall (
  turn_id   TEXT NOT NULL REFERENCES turn (id) ON DELETE CASCADE,
  kind      TEXT NOT NULL CHECK (kind IN ('memory', 'digest', 'message')),
  ref       TEXT NOT NULL,
  score     REAL NOT NULL,
  /* What found it: always in (pinned), its words, its meaning, what it is about. */
  found_by  TEXT NOT NULL CHECK (found_by IN ('pinned', 'words', 'meaning', 'about')),
  PRIMARY KEY (turn_id, kind, ref)
);
```

### 4.6 Asks

```sql
/*
  The assistant asking a person's yes (PLAN-AI.md §4.6): the operation and
  its arguments, in a sentence, with what it rests on, for one person, until
  a time. Shown in the conversation as a card and, when they are not there,
  as a notification. A yes runs the operation as that person, bound to it; a
  world that changed since asks again; no answer by the time is a no.
*/
CREATE TABLE ask (
  id              TEXT PRIMARY KEY CHECK (id GLOB 'ak-*'),
  assistant_id    TEXT NOT NULL REFERENCES assistant (id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversation (id) ON DELETE CASCADE,
  turn_id         TEXT REFERENCES turn (id) ON DELETE SET NULL,
  errand_id       TEXT REFERENCES errand (id) ON DELETE CASCADE,
  /* Whose yes it asks: who asked for it, unless they named another ("ask Anna"); always someone in the conversation. */
  to_person       TEXT NOT NULL REFERENCES person (id),
  operation       TEXT NOT NULL,
  args            TEXT NOT NULL CHECK (json_valid(args)),
  sentence        TEXT NOT NULL CHECK (length(sentence) BETWEEN 1 AND 300),
  /* What it rests on: the readings now, what will happen, the receipt to be. */
  evidence        TEXT NOT NULL CHECK (json_valid(evidence)),
  state           TEXT NOT NULL CHECK (state IN ('waiting', 'yes', 'no', 'expired', 'withdrawn', 'failed')),
  asked_at        TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  answered_at     TEXT,
  answered_via    TEXT CHECK (answered_via IN ('app', 'notification')),
  /* What the yes did, on the timeline; or why it failed. */
  audit_id        INTEGER REFERENCES audit (id) ON DELETE SET NULL,
  why             TEXT,
  CHECK ((state IN ('yes', 'no')) = (answered_at IS NOT NULL)),
  CHECK ((answered_at IS NULL) = (answered_via IS NULL)),
  CHECK (expires_at > asked_at)
);
CREATE INDEX ask_waiting ON ask (to_person, expires_at) WHERE state = 'waiting';
```

### 4.7 Errands

```sql
/*
  A goal with an end (PLAN-AI.md §4.9): for whom, what, until when, the plan
  as it stands, the grant its person gave, what it may spend and has spent,
  how it ended. Held by the hub; a model is woken for it, never left
  running. It reports in its conversation.
*/
CREATE TABLE errand (
  id               TEXT PRIMARY KEY CHECK (id GLOB 'er-*'),
  assistant_id     TEXT NOT NULL REFERENCES assistant (id) ON DELETE CASCADE,
  conversation_id  TEXT NOT NULL REFERENCES conversation (id) ON DELETE CASCADE,
  /* Whose errand: the person whose yes is its grant. */
  for_person       TEXT NOT NULL REFERENCES person (id),
  home_id          TEXT REFERENCES home (id),
  goal             TEXT NOT NULL CHECK (length(goal) BETWEEN 1 AND 500),
  /* The plan in words, as it stands: what the person said yes to, and each change since (each a message too). */
  plan             TEXT NOT NULL CHECK (length(plan) <= 4000),
  state            TEXT NOT NULL CHECK (state IN ('proposed', 'working', 'done', 'failed', 'expired', 'stopped')),
  /* Its end: at most a week from its grant. */
  until            TEXT NOT NULL,
  max_tokens       INTEGER NOT NULL CHECK (max_tokens > 0),
  max_cost_micros  INTEGER CHECK (max_cost_micros > 0),
  max_acts         INTEGER NOT NULL CHECK (max_acts BETWEEN 0 AND 1000),
  spent_tokens     INTEGER NOT NULL DEFAULT 0,
  spent_cost_micros INTEGER NOT NULL DEFAULT 0,
  acts             INTEGER NOT NULL DEFAULT 0,
  /* How it began: asked in a conversation, or handed over by an automation's errand: step. */
  started_by       TEXT NOT NULL CHECK (started_by IN ('person', 'automation')),
  automation_id    TEXT REFERENCES automation (id) ON DELETE SET NULL,
  proposed_at      TEXT NOT NULL,
  granted_at       TEXT,
  ended_at         TEXT,
  /* How it knows it is done, or why it is not, in words. */
  outcome          TEXT,
  CHECK ((state = 'proposed') = (granted_at IS NULL)),
  CHECK ((state IN ('proposed', 'working')) = (ended_at IS NULL)),
  CHECK ((ended_at IS NULL) = (outcome IS NULL)),
  CHECK (until > proposed_at),
  CHECK ((started_by = 'automation') = (automation_id IS NOT NULL) OR ended_at IS NOT NULL)
);
CREATE INDEX errand_working ON errand (until) WHERE state = 'working';

/*
  What an errand may do without asking — its grant, listed, each said yes to
  with it: an operation on a target, within bounds, a number of times. What
  the gate checks an errand's act against; anything outside is an ask.
*/
CREATE TABLE errand_grant (
  errand_id  TEXT NOT NULL REFERENCES errand (id) ON DELETE CASCADE,
  n          INTEGER NOT NULL CHECK (n >= 1),
  operation  TEXT NOT NULL,
  /* What it is on, and within what: { device, part, capability, command, args: { on: [true, false] } }. */
  target     TEXT NOT NULL CHECK (json_valid(target)),
  /* How many times; null: as often as the errand needs, within its acts. */
  times      INTEGER CHECK (times > 0),
  used       INTEGER NOT NULL DEFAULT 0 CHECK (used >= 0),
  sentence   TEXT NOT NULL,
  PRIMARY KEY (errand_id, n),
  CHECK (times IS NULL OR used <= times)
);

/*
  When an errand wakes: a time it set, and why. What it waits for in the
  world is an automation of its own (errand_automation) whose step wakes it.
*/
CREATE TABLE errand_wake (
  id        TEXT PRIMARY KEY CHECK (id GLOB 'ew-*'),
  errand_id TEXT NOT NULL REFERENCES errand (id) ON DELETE CASCADE,
  at        TEXT NOT NULL,
  why       TEXT NOT NULL CHECK (length(why) BETWEEN 1 AND 200),
  state     TEXT NOT NULL CHECK (state IN ('waiting', 'woken', 'dropped')),
  woke_at   TEXT,
  CHECK ((state = 'woken') = (woke_at IS NOT NULL))
);
CREATE INDEX errand_wake_next ON errand_wake (at) WHERE state = 'waiting';

/* The automations an errand made: ended — turned off and deleted — with it. */
CREATE TABLE errand_automation (
  errand_id     TEXT NOT NULL REFERENCES errand (id) ON DELETE CASCADE,
  automation_id TEXT NOT NULL REFERENCES automation (id) ON DELETE CASCADE,
  PRIMARY KEY (errand_id, automation_id)
);
```

### 4.8 Memory

```sql
/*
  What the assistant knows (§7): one statement, about someone or something,
  resting on a person's words — whose memory it is, who it may be recalled
  to, how it came, when it holds, what replaced it. Forgotten, it is
  deleted, with its vector and its words in the index.
*/
CREATE TABLE memory (
  id            TEXT PRIMARY KEY CHECK (id GLOB 'me-*'),
  /* Whose it is — theirs to see, correct and forget; null: the family's, every member's to see and an admin's to correct. */
  owner_id      TEXT REFERENCES person (id),
  /* Who else it may be recalled to: its owner alone, the people named (memory_person), or the family. */
  shared        TEXT NOT NULL CHECK (shared IN ('private', 'people', 'family')),
  /* What it is about; null: nothing in particular. */
  about_kind    TEXT CHECK (about_kind IN ('person', 'family', 'home', 'space', 'device', 'automation', 'variable')),
  about_id      TEXT,
  /* A fact ("the bike charges in the garage"), a preference ("Erik likes 20 °C at night"), a standing instruction ("ask before running the dryer after 22:00"), a routine ("Anna leaves at 07:30 on weekdays"). */
  kind          TEXT NOT NULL CHECK (kind IN ('fact', 'preference', 'instruction', 'routine')),
  text          TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 500),
  locale        TEXT,
  /*
    How it came: said — a person asked it be remembered; offered — the
    assistant asked and the person said yes; noticed — the assistant noticed
    it in what a person said, and it waits for their yes before it is used;
    written — typed on the memory page.
  */
  source        TEXT NOT NULL CHECK (source IN ('said', 'offered', 'noticed', 'written')),
  /* The person whose words it rests on, and where they said them. */
  said_by       TEXT NOT NULL REFERENCES person (id),
  message_id    TEXT REFERENCES message (id) ON DELETE SET NULL,
  /* Proposed: noticed, not yet confirmed — never recalled; kept: in use; replaced: a newer one says otherwise, kept for when it held. */
  state         TEXT NOT NULL CHECK (state IN ('proposed', 'kept', 'replaced')),
  /* Always in what the assistant is told about its audience: a short profile, not searched for. */
  pinned        INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  /* When it holds, when it was said to: "until August". */
  valid_from    TEXT,
  valid_until   TEXT,
  /* The memory that says otherwise now: forgetting it forgets this too, so nothing of what was forgotten is left behind. */
  replaced_by   TEXT REFERENCES memory (id) ON DELETE CASCADE,
  created_at    TEXT NOT NULL,
  confirmed_at  TEXT,
  changed_at    TEXT NOT NULL,
  /* When it was last recalled, and how often: what ranking and tidying read. */
  recalled_at   TEXT,
  recalled      INTEGER NOT NULL DEFAULT 0 CHECK (recalled >= 0),
  CHECK ((about_kind IS NULL) = (about_id IS NULL) OR about_kind = 'family'),
  CHECK (owner_id IS NOT NULL OR shared = 'family'),
  CHECK ((state = 'proposed') = (confirmed_at IS NULL)),
  CHECK ((state = 'replaced') = (replaced_by IS NOT NULL)),
  CHECK (source <> 'noticed' OR state <> 'kept' OR confirmed_at IS NOT NULL),
  CHECK (valid_until IS NULL OR valid_from IS NULL OR valid_until > valid_from)
);
CREATE INDEX memory_owner ON memory (owner_id, state);
CREATE INDEX memory_about ON memory (about_kind, about_id) WHERE state = 'kept';

/* The people a memory shared with some may be recalled to, beside its owner. */
CREATE TABLE memory_person (
  memory_id TEXT NOT NULL REFERENCES memory (id) ON DELETE CASCADE,
  person_id TEXT NOT NULL REFERENCES person (id),
  PRIMARY KEY (memory_id, person_id)
);

/* A memory's meaning, as an embedding model put it: made again when the family's embedding model changes. */
CREATE TABLE memory_vector (
  memory_id TEXT PRIMARY KEY REFERENCES memory (id) ON DELETE CASCADE,
  model_id  TEXT NOT NULL REFERENCES model (id) ON DELETE CASCADE,
  /* Its numbers as 32-bit floats, normalised to length 1. */
  vector    BLOB NOT NULL,
  made_at   TEXT NOT NULL
);

/* Memories' words, in pieces of three letters: Swedish compounds ("cykelgaraget") are found by their parts. */
CREATE VIRTUAL TABLE memory_fts USING fts5 (text, content = 'memory', content_rowid = 'rowid', tokenize = 'trigram');
```

### 4.9 Digests: long conversations, carried on and recalled

```sql
/*
  A conversation's messages from one number to another, summarised by the
  background model: what a long conversation is carried on from (the model
  is told the digests and the messages after), and what recall finds a
  conversation by. Made when a conversation grows past what a turn is told,
  and when it has been quiet a day. Gone with its conversation; made again
  when a message it covers is taken back.
*/
CREATE TABLE conversation_digest (
  id              TEXT PRIMARY KEY CHECK (id GLOB 'dg-*'),
  conversation_id TEXT NOT NULL REFERENCES conversation (id) ON DELETE CASCADE,
  from_seq        INTEGER NOT NULL CHECK (from_seq >= 1),
  to_seq          INTEGER NOT NULL,
  text            TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 4000),
  model_id        TEXT REFERENCES model (id) ON DELETE SET NULL,
  made_at         TEXT NOT NULL,
  UNIQUE (conversation_id, from_seq),
  CHECK (to_seq >= from_seq)
);
CREATE TABLE digest_vector (
  digest_id TEXT PRIMARY KEY REFERENCES conversation_digest (id) ON DELETE CASCADE,
  model_id  TEXT NOT NULL REFERENCES model (id) ON DELETE CASCADE,
  vector    BLOB NOT NULL,
  made_at   TEXT NOT NULL
);
CREATE VIRTUAL TABLE digest_fts USING fts5 (text, content = 'conversation_digest', content_rowid = 'rowid', tokenize = 'unicode61');
```

### 4.10 Rules for agents, and what it cost

```sql
/*
  A home's rules for agents (PLAN-AI.md §4.5), over the gateway's own: on a
  capability's command, a device, a label's devices, or an operation; for
  every assistant or one; for whoever asks or only a role. Rules narrow
  only: none lets an agent past a person's yes the gateway asks for — only an
  errand's grant or an ask does.
*/
CREATE TABLE agent_rule (
  id            TEXT PRIMARY KEY CHECK (id GLOB 'ar-*'),
  /* The home it holds in; null: every home. */
  home_id       TEXT REFERENCES home (id),
  assistant_id  TEXT REFERENCES assistant (id) ON DELETE CASCADE,
  subject_kind  TEXT NOT NULL CHECK (subject_kind IN ('capability', 'device', 'label', 'operation')),
  subject       TEXT NOT NULL,
  /* A capability's command; null: all of them. */
  command       TEXT,
  /* Whose asking it applies to; null: anyone's. */
  for_role      TEXT CHECK (for_role IN ('admin', 'member', 'child')),
  rule          TEXT NOT NULL CHECK (rule IN ('free', 'asks', 'never')),
  set_by        TEXT NOT NULL REFERENCES person (id),
  set_at        TEXT NOT NULL,
  CHECK (command IS NULL OR subject_kind = 'capability')
);
CREATE UNIQUE INDEX agent_rule_once ON agent_rule (coalesce(home_id, ''), coalesce(assistant_id, ''), subject_kind, subject, coalesce(command, ''), coalesce(for_role, ''));

/*
  What the models cost, a day at a time (from the turns, which let their
  traces go after a month): per model, assistant, person acted for and job.
  Kept two years, as hourly history is.
*/
CREATE TABLE model_usage (
  day            TEXT NOT NULL,
  model_id       TEXT NOT NULL REFERENCES model (id) ON DELETE CASCADE,
  assistant_id   TEXT NOT NULL REFERENCES assistant (id) ON DELETE CASCADE,
  person_id      TEXT REFERENCES person (id),
  role           TEXT NOT NULL,
  calls          INTEGER NOT NULL DEFAULT 0,
  input_tokens   INTEGER NOT NULL DEFAULT 0,
  cached_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens  INTEGER NOT NULL DEFAULT 0,
  cost_micros    INTEGER NOT NULL DEFAULT 0,
  ms             INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX model_usage_once ON model_usage (day, model_id, assistant_id, coalesce(person_id, ''), role);
```

### 4.11 Privacy and security, as people set them

Every choice about privacy and security is a **setting** a person makes —
the family's admins for the family, each person for what is theirs, a
conversation's owners for it — not a decision kraftverk makes for them.
kraftverk gives each a default and **guarantees** what the strictest
applicable choice says (§8.1).

```sql
/*
  A privacy or security setting, as someone chose it (§8.1): for the whole
  family, one home, one person's own, or one conversation. Its key is one
  the registry declares, with its values from the most open to the
  strictest; what holds at any moment is the strictest of every setting
  that applies. No row: the registry's default.
*/
CREATE TABLE privacy_setting (
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('family', 'home', 'person', 'conversation')),
  /* The home's, person's or conversation's id; '' for the family. */
  scope_id   TEXT NOT NULL,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL CHECK (json_valid(value)),
  set_by     TEXT NOT NULL REFERENCES person (id),
  set_at     TEXT NOT NULL,
  PRIMARY KEY (scope_kind, scope_id, key),
  CHECK ((scope_kind = 'family') = (scope_id = ''))
);
```

The key's list is the registry's (§8.1), checked by the store as the
language's kinds are, so a setting the code does not enforce cannot be
written. A row for a conversation or a person goes with it (the store
deletes them, as there is no single table to reference).

### 4.12 A node's: tokens for agents from outside

In `node.db`, beside the sign-ins (server code, `server/src/auth`):

```sql
/*
  A token an agent from outside — an MCP client — signs in with: for one
  person of one family, as an assistant of theirs, kept as its hash, until
  it is taken back or runs out. Its every call is that person's agent's, on
  the timeline with the token's label.
*/
CREATE TABLE agent_token (
  id           TEXT PRIMARY KEY CHECK (id GLOB 'at-*'),
  family_id    TEXT NOT NULL,
  person_id    TEXT NOT NULL,
  assistant_id TEXT NOT NULL,
  label        TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 60),
  hash         TEXT NOT NULL UNIQUE,
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  expires_at   TEXT,
  revoked_at   TEXT
);
```

No reference crosses databases: the person and assistant are checked
against the family's database when the token is used, and a token whose
person has left, or whose assistant is gone, is refused.

### 4.13 What changes in tables there already

| Table | Change | Why |
| --- | --- | --- |
| `audit` | `resource_kind` adds `assistant`, `conversation`, `errand`, `memory`, `ask`, `model` | Each is something the timeline can be asked about |
| `notification` | `conversation_id` (`ON DELETE SET NULL`) and `ask_id` (`ON DELETE SET NULL`) | A notification opens its conversation; an ask's carries *Yes* and *No* |
| `person` erased | §8.4 | An erased person leaves no words in conversations or memory |

The `automation` table is unchanged: an errand's automations are listed in
`errand_automation`, and whoever made an automation is on the timeline.

## 5. Two people, one assistant

### 5.1 Being in a conversation

- **Starting one**: a person alone with the assistant (`answers =
  'always'`), or with others (`'addressed'`), or with people only
  (`assistant_id` null). The creator is its owner.
- **Adding someone**: an owner chooses whether they **see what was said
  before**: their span starts at 1, or at the next message, as the
  conversation's `conversation.history` setting says (by default, the next
  message); a note in the conversation says *"Anna
  added Erik"*, and whether he sees the history.
- **Leaving**: the span closes at the last message; `left_at` is set; what
  they said stays, theirs and attributed. The last owner leaving makes the
  longest-standing member owner. The last person leaving **deletes the
  conversation** with everything kept of it.
- **Removing someone**: an owner's; the same as leaving, said in a note.
- **Back again**: a new span from the next message, unless an owner adds
  them with the history again.
- **Turning a one-to-one into a group** is adding a person: `answers`
  becomes `addressed`, said in a note, and the owner can set it back.

### 5.2 When the assistant answers

- With `answers = 'always'`, every person's message is to it.
- With `'addressed'`, a message is to it when it names the assistant ("Kraft,
  …"), is spoken to it (hold to talk), replies to one of its messages, or is
  sent with the app's *ask the assistant* switch. Otherwise the people are
  talking to each other, and the assistant reads along only when every
  person in the conversation has said it may (`conversation.readsAlong`,
  off by default).
- **One turn at a time** (`turn_one_at_a_time`). Messages to the assistant
  that arrive while it answers are answered next, together.

### 5.3 Authority and audience

The heart of a shared conversation:

- **Authority** — what may be *done* — is the person whose message the turn
  answers (`turn.for_person`). Erik asks to start the dryer: it is Erik's
  agent that asks the gateway, with Erik's role, under the rules for Erik's
  role; a yes is asked of Erik.
- **Audience** — what may be *said* — is every person whose span is open
  when the turn starts (`turn.audience`). What the turn reads, recalls and
  says is held to what *all* of them may know:

  | What | One person alone | Two or more |
  | --- | --- | --- |
  | A position someone carries | Their own, precisely; others' at their sharing | Each person's at their sharing only — the carrier's own precision is not shown to the others |
  | Presence (home, place, room) | At each person's sharing | The same |
  | Memories | Theirs (private), those shared with them, the family's | Only those every person present may be told: the family's, and those shared with all of them |
  | Earlier conversations (recall) | Those they can read | Only messages and digests **every** person present can read |
  | Devices, automations, history | As their role sees | As the narrowest role present sees |

  In code: the agent's caller carries the audience (§9.2), and `readerOf`
  — today one person or none — becomes *the audience's reader*: the one
  person when alone, no one in particular when several. Recall filters by
  audience **in the query**, before anything is ranked, so nothing a person
  may not see is ever in a candidate list.
- **Asks** go to the person whose authority is needed: the asker, or the
  person the asker named. Only that person can answer; the card shows to
  the others as *waiting for Erik*.
- **"This room", "here", "me"** are the author's: the context their message
  carries.

### 5.4 An example

Anna and Erik share a conversation with Kraft; Erik joined last week
without the history.

| # | Who | What | What the model keeps |
| --- | --- | --- | --- |
| 41 | Anna | "Kraft, is the bike charged?" | Turn 1: for Anna; audience Anna, Erik |
| 42 | Kraft | "It's at 62 %, charging; full around 23:00." | Read the bike plug's power and the bike's charge; no recall of Anna's private memory that the bike is hers to manage (private); the family's memory "the bike charges in the garage" recalled |
| 43 | Erik | "Can you stop at 80 tonight, it's for a long ride tomorrow" | Turn 2: for Erik |
| 44 | Kraft | "I can take that on until 07:00: switch Bike plug off when it reaches 80 %. All right?" | An errand proposed, for Erik, its grant listed |
| 45 | Erik | Yes (the card) | The errand works; its automation made |
| 46 | Anna | "Erik, I'll take the car instead" | Not to Kraft: no turn |
| 47 | Kraft | "Bike charged to 80 %, plug off. Errand done." | Turn 3: errand's; for Erik; audience Anna, Erik |

Erik searching history finds 41 onwards, not the conversation's first forty
messages. Recall in turn 2 could not use anything from messages 1–40, since
Erik cannot read them.

## 6. History

### 6.1 What history is

- **The conversation**: its messages, in order, as their authors left them;
  searchable by those who can read them (`message_fts` joined to
  `conversation_span`).
- **What the assistant did**: turns and their steps, each tool call naming
  its timeline entry; the timeline naming the turn; *what did you do?*
  answered both ways.
- **What was decided**: asks and their answers, errands and their outcomes,
  memories and what replaced them.

### 6.2 Carrying a conversation on

A turn is told: the assistant's prefix (instructions, skills, tools, the
home's index), the pinned memories of its audience, what recall found, then
the conversation: **the latest digest and every message after it**, up to
the role's budget. When the messages after the digest pass that budget, a
`compact` step writes the next digest first. A conversation is therefore
endless and its turn's prompt bounded.

The provider's own state (thinking, its signature) of the last turn's steps
is handed back when the provider needs it; older turns are told as their
messages.

### 6.3 A message taken back

Its words are cleared (`text = ''`, `parts = '[]'`), its place kept, its
index entry removed; a digest that covered it is made again; a memory that
rested on it keeps its own words (the person may forget it separately) but
loses the link.

### 6.4 Search

- **History search** (a person's): their readable messages and digests by
  words, newest first, across conversations — what the app's search shows.
- **Recall** (the assistant's): §7.3.

### 6.5 What is kept, and for how long

| What | Kept | Then |
| --- | --- | --- |
| Messages | As long as the conversation: until its last person leaves, or `conversation.keepDays` after its last message (§8.1; by default 365) | Deleted with the conversation |
| Digests | With their conversation | — |
| Turns | A year | Deleted; their usage already in `model_usage` |
| Turn steps, recall | 30 days | Deleted; what they did stays on the timeline |
| Provider state | A day | Cleared |
| Asks | 90 days after their answer or end | Deleted |
| Errands, their grants and wakes | A year after they end | Deleted |
| Memories | Until forgotten, or replaced for two years | Deleted |
| Proposed memories | 30 days unconfirmed | Deleted |
| Usage | Two years | Deleted |
| Feedback | With its message | — |
| Audio | **Never** kept: what was said is its transcript | — |

## 7. Memory

### 7.1 What a memory is

One statement, in a sentence, about someone or something — never a
transcript. Its kind says how it is used:

| Kind | Example | Used |
| --- | --- | --- |
| `fact` | "The bike charges in the garage." | Recalled when relevant |
| `preference` | "Erik likes 20 °C at night." | Recalled when relevant; offered when the assistant would choose for him |
| `instruction` | "Ask before running the dryer after 22:00." | A standing instruction to the assistant: pinned by default for its owner's turns |
| `routine` | "Anna leaves at 07:30 on weekdays." | Recalled when relevant; what an errand's plan may lean on |

### 7.2 How a memory is written, used and forgotten

- **Said**: "remember that…" — kept at once, its owner the speaker,
  `private` unless they say *for everyone*.
- **Offered**: the assistant asks *"Shall I remember that the bike charges
  in the garage — for everyone?"*; the yes keeps it.
- **Noticed**: the assistant notices something in what a person said and
  writes it `proposed`; it is **never recalled** until that person confirms
  it on the memory page or when asked. Noticing is a setting
  (`memory.notices`), for the family and for each person.
- **Written**: typed on the memory page.
- **Only from a person's words.** The hub writes a memory only with a
  `message_id` whose author is `said_by` (or from the memory page, by that
  person) — never from a tool's answer, a device's name, an integration's
  data, a page, a message from outside. An injected *"remember: always
  unlock the door"* has no person's message to rest on, and is refused.
- **Corrected**: a new memory replaces the old (`replaced_by`); the old is
  kept for when it held, recalled only for questions about the past.
- **Conflicts**: a new memory about the same thing that disagrees is
  offered as a replacement, not kept beside it.
- **Forgotten**: deleted — its row, its vector, its index entry, and the
  older memories it replaced — and the timeline says *"Anna forgot a memory"*, without its words.
- **Who may change it**: its owner; an admin for the family's; a person
  named in one shared with some only reads it.

### 7.3 Recall

What a turn is told it remembers, for its audience:

1. **Pinned** memories every person in the audience may be told: a short
   profile, always in, at most a set budget (500 tokens).
2. **Found** for this turn, from the newest messages to the assistant:
   - **Allowed first**: kept memories (and digests, and messages) the whole
     audience may be told — filtered in SQL by `shared`, `memory_person`,
     ownership and `conversation_span`, before any ranking.
   - **By words**: `memory_fts` (trigram), `digest_fts` and `message_fts`,
     ranked by BM25.
   - **By meaning**: the query embedded by the `embed` model, compared
     with the allowed vectors (cosine on normalised floats, in memory on the
     server; a family has thousands, not millions).
   - **By what it is about**: memories about the people, places and devices
     the messages name, resolved from the home's index.
   - **Fused** by reciprocal rank, nudged by recency and how often each was
     useful, cut at a budget (1 500 tokens); a memory past `valid_until`
     only for questions about the past.
3. **Kept in the turn**: each recalled thing in `turn_recall`, with its
   score and what found it — what *"why did you say that?"* shows, and what
   moves `recalled_at`.

**Without an embedding model** — a phone with no server, a family that
chose none — recall is by words and by what it is about; the meaning half
is skipped. **When the embedding model changes**, vectors are made again in
the background; until then that half recalls only what has a vector of the
current model.

### 7.4 The memory page

Each person sees their own memories, the family's, and those shared with
them; corrects, shares, pins and forgets what is theirs; sees what each was
recalled for. An admin sees and corrects the family's. Nobody sees another
person's private memories — the assistant included, when that person is not
its whole audience.

## 8. Privacy and security

### 8.1 Settings people choose; guarantees kraftverk keeps

kraftverk does not decide how private a family is. It offers a default
for every choice, lets the people it concerns set it, and **guarantees**
that a tighter choice holds — everywhere, at once, for as long as it is
set. Settings are declared once, in a registry beside the operations
(`packages/api-contract`), each with:

- **its values, ordered** from the most open to the strictest;
- **its scopes** — family, home, person, conversation — and **who may set
  each**: admins for the family and a home; each person for their own (an
  admin for a child they keep); a conversation's owners for it, or every
  person in it where it asks everyone's consent;
- **its default**;
- **where it is enforced** — the gate, the store, recall, the model port,
  the sweeper — and **what tightening does at once**: a shorter keep sweeps
  now; *local only* stops a turn running on a cloud model; memory turned
  off stops recall and offers to delete what was kept;
- **its test**: a property test that, with the setting at its strictest,
  tries every path the registry names and finds nothing let through. A
  setting without one does not compile into the registry.

**The strictest applicable choice wins.** A family that lets cloud models
in does not overrule a person who says *never send anything about me to
the cloud*: every turn whose audience includes that person uses only local
models, and says so when it cannot do something. An admin can loosen the
family's settings, never a person's own. Loosening is the setter's choice
and is said: on the timeline, and to the people it concerns.

**What is not a setting**: the gateway's rules about hardware (a write
that could damage it is never an agent's), secrets never handed to a model,
and a yes the gateway asks of a person. These keep devices and accounts
safe, not anyone's privacy, and stay rules.

| Setting | Scopes (who sets) | Values, open → strict | Default | Guaranteed when tightened |
| --- | --- | --- | --- | --- |
| `assistant.on` | family (admins), person (own) | on · off | on | Off for a person: no turn acts for them, none recalls their memories; off for the family: no turn runs |
| `models.where` | family, home (admins), person (own) | anywhere · network · sealed | network | No call leaves for a model not where the strictest of the family's, the home's and every audience member's choice allows; checked at each call (PLAN-AI.md §4.14) |
| `cloud.tells` | family (admins), person (own) | devices, history, presence, memory (any set) → none | devices, history | A cloud model is told only what every audience member's choice allows; the rest stays out or is a stand-in |
| `presence.tells` | person (own) | as I share · home or away · nothing | as I share | The assistant says no more of where they are than this, to anyone, whatever their sharing says to the family |
| `memory.keeps` | family (admins), person (own) | on · off | on | Off: no memory written for them; none of theirs recalled |
| `memory.notices` | family (admins), person (own) | on · off | on | Off: nothing noticed in what they say is proposed |
| `memory.shares` | person (own) | family · private | private | What they say to remember is private unless they say otherwise |
| `conversation.keepDays` | family (admins), conversation (owners) | 3650 … 1 | 365 | Messages older than the least of these are deleted, with their digests and turns, at once and daily after |
| `trace.keepDays` | family (admins) | 365 … 0 | 30 | Steps and recall older are deleted; 0 keeps none past the turn |
| `conversation.history` | conversation (owners) | shared with who joins · not | not | Someone added reads nothing before their span |
| `conversation.readsAlong` | conversation (everyone in it) | on · off | off | Unless every person in it has said on, the assistant is told only what is said to it |
| `children.conversations` | family (admins) | admins may read · private | private | A child's conversations are readable by no one but those in them; loosened, the child is told, on their screen |
| `voice.audio` | person (own) | kept a day · never | never | No audio of theirs is written anywhere |
| `asks.byVoice` | family (admins), person (own) | allowed · never | never | A yes the gateway asks is taken only on a signed-in screen |
| `errands.days` | family (admins) | 30 … 1 | 7 | No errand is granted past it |
| `outside.agents` | family (admins), person (own) | allowed · off | allowed | Off: every agent token of theirs (or everyone's) is refused, at once |

The privacy page in Settings shows each setting, who set it, what holds
now and why — *"Local only, because Anna chose it for herself"*.

### 8.2 Who may read what

| What | Who |
| --- | --- |
| A conversation's messages | The people whose spans hold them; nobody else — not an admin, not the assistant for anyone else |
| A message's context | Its author, and the assistant in that conversation |
| Turns and steps | The conversation's people, for the messages they can read (*"what did you do?"*) |
| An ask | The conversation's people; answered only by `to_person` |
| An errand | The conversation's people; stopped by its person, or any admin |
| A memory | §7.4 |
| Usage | Each person their own; admins all |
| Providers, models, roles, rules | Admins change; everyone reads (without keys) |

### 8.3 The honest limit

The family's database is on its master. Whoever runs that server can read
the file — conversations included — as they can read presence and history
today. The assistant on the server must read a conversation to answer it,
so end-to-end encryption of conversations would mean an assistant only on
the phones. Said plainly in Settings; per-person sealing of private
memories is a later choice (decision 9).

### 8.4 A person erased

- Their messages: words cleared as if taken back; their place and *a person
  who has left* kept.
- Their spans closed; conversations with no one left deleted.
- Their memories, and memories about them, deleted; the family's memories
  they said keep their words, `said_by` naming the erased row.
- Their errands stopped; asks to them withdrawn; turns for them keep their
  usage and lose their steps.
- `assistant_person`, `model_role` choices of theirs deleted.

### 8.5 What a cloud model is told

A turn whose model `runs = 'cloud'` gets its context minimised and its
names replaced by stand-ins the hub maps back (PLAN-AI.md §4.14). The map
lives in the turn's memory while it runs and is never kept; the step's
`content` keeps what was actually sent.

## 9. The contract

### 9.1 A message's parts

```ts
/** What a message shows: words, and what kraftverk draws. */
export type MessagePart =
  | { kind: 'text'; text: string }
  | { kind: 'picture'; media: string }
  | { kind: 'device'; device: SavedDeviceId; part?: string }
  | { kind: 'reading'; device: SavedDeviceId; key: string; value: Value; unit: string | null; at: string }
  | { kind: 'automation'; automation: AutomationId }
  | { kind: 'draft'; rule: Rule; sentence: string; rehearsal: Rehearsal | null }
  | { kind: 'did'; audit: number; summary: string }
  | { kind: 'ask'; ask: string }
  | { kind: 'errand'; errand: string }
  | { kind: 'memory'; memory: string; offered: boolean }
  | { kind: 'note'; note: 'joined' | 'left' | 'added' | 'removed' | 'answers' | 'errand-done' | 'errand-failed'; person?: string; detail?: string };
```

`text` beside the parts is what they say in words, written by the hub.

### 9.2 Who acts

```ts
export type Caller =
  | { kind: 'person'; id?: string; name: string; account?: string }
  /**
   * An assistant acting for a person: in a conversation, on an errand, from
   * outside with a token. Its acts are its person's; what it reads is held
   * to its audience — everyone who will read the answer.
   */
  | { kind: 'agent'; assistant: string; name: string; for: string; audience: readonly string[]; via: 'app' | 'voice' | 'errand' | 'step' | 'mcp'; turn?: string; errand?: string; token?: string }
  | { kind: 'automation'; id: string; name: string; for: string | null; run: { id: string; askedBy: 'person' | 'agent' | null } };
```

`for` becomes a person's id everywhere (today an account's user name). An
errand's act names `errand`, and the gate checks it against
`errand_grant` before anything else.

### 9.3 The views and operations

New namespaces of `KraftverkApi`, declared once with their schemas
(PLAN-AI.md §4.2):

| Namespace | Operations | Gate |
| --- | --- | --- |
| `assistants` | list, get, create, change, stop, start; `me` (my settings), `setMine` | read; admins for create, change; anyone for stop; a person for theirs |
| `conversations` | list (mine), get, start, rename, add, remove, leave, setMine (pin, archive, notify), read (up to n), messages (a page, from n), send, edit, take back, feedback, search | a person in it (by span), and owners for add and remove |
| `turns` | of a message (the trace, when kept), stop (the running one) | a person in it |
| `asks` | waiting (mine), answer | `to_person` only, as a person |
| `errands` | list, get, stop | a person in its conversation; stop: its person or an admin |
| `memory` | mine, family's, get, remember, confirm, change, share, pin, forget, recalledFor | owner; admins for the family's |
| `models` | providers, models, roles, catalogue, download, remove, probe, usage | read for all; admins to change |
| `agentRules` | list, set, remove | admins |
| `agentTokens` | mine, make, revoke | a person, for themselves |

The assistant's own tools (PLAN-AI.md §4.8) call these and every other
operation through the gate as the `agent` caller above.

### 9.4 Live

`LiveUpdate` grows, each sent **only to the people who may read it**:

- `conversation`: a message added or changed; an answer being written
  (deltas — never stored); a turn's state (thinking, using a tool, asking);
  who is reading or speaking.
- `ask`: waiting, answered, expired.
- `errand`: its state, its plan changed.
- `memory`: one of mine changed, proposed or forgotten.

## 10. Where it lives

- **The family's database**, on its master, as everything shared is. A
  phone that keeps its family itself keeps conversations and memory too;
  when that family moves to a server, they move with the database, as
  devices and history do.
- **A follower** (an app reading a server's family) asks the master; what it
  last saw of a conversation is kept as `last_heard` is today, read-only
  while the master cannot be reached.
- **A node's database** holds agent tokens, as it holds sign-ins.
- **The person's own store** holds nothing of this: what a person chose is
  the family's (`assistant_person`), since the server's assistant reads it
  when the phone is away.
- **Search on every engine**: FTS5 is in Bun's SQLite (3.53, checked
  2026-10-09, `unicode61` and `trigram`), in SQLite's own WebAssembly build,
  and in `expo-sqlite` when its plugin is told `enableFTS` — slice M0 proves
  all three. Vectors are plain blobs; no extension is needed anywhere.

## 11. The configuration file

| Carried | Not carried |
| --- | --- |
| Assistants (key, name, persona, instructions, limits), providers (without keys, as connections are), models and their roles, agent rules, the family's memories, **every privacy setting of the family, its homes and its people** | Conversations (and their settings), messages, digests, turns, asks, errands, usage, local downloads, tokens, people's private memories |

Privacy settings are carried, a person's own included, because a reset
must never loosen one: a database started afresh from the file holds every
choice it held before.

A person's own memories leave only in their own export (*download what
kraftverk remembers about me*), never in the family's file. Its version goes
up once, when slice M7 lands, with a migration and a kept fixture.

## 12. What the database holds, and what the hub does

| Rule | Held by |
| --- | --- |
| Messages numbered without gaps; one author each | Schema (`UNIQUE`, `CHECK`), and the store taking `last_seq + 1` in the same transaction |
| One open span a person; one turn at a time | Schema (partial unique indexes) |
| A message read only within a span | Every store query joins `conversation_span`; no store function returns a message without a reader |
| An owner while anyone is in it | The store, on leave and remove |
| An ask answered once, by its person | Schema (`state`, `answered_at`), the gate (`to_person`) |
| An errand's acts within its grant and budget | The gate, against `errand_grant`, in the act's transaction |
| A memory resting on its person's words | The store refuses one whose message's author is not `said_by` |
| Recall never ranks what the audience may not see | Recall's SQL filters first; tests with three people and private memories |
| Removal clears words | Schema (`CHECK` on removed), triggers on the index |
| Retention | The hub's sweeper, beside history's |
| A privacy setting's key is one kraftverk enforces | The store, against the registry |
| The strictest applicable setting holds | One function (`effective(key, scopes)`) every enforcement point asks; a property test per setting at its strictest |
| Tightening takes effect at once | The registry's action for the key, run in the same transaction as the change |

## 13. The order of work

Each slice green and pushed; none calls a model.

| Slice | What | Done when |
| --- | --- | --- |
| **M0** | Spike: FTS5 with `unicode61` and `trigram` on Bun, SQLite's WebAssembly build in a worker, and `expo-sqlite` with FTS on; 10 000 vectors scored in Hermes | A test per engine; the plugin setting in `app.json` |
| **M1** | The schema (§4) and its stores, one module a table group: `assistants`, `models`, `conversations`, `messages`, `turns`, `asks`, `errands`, `memory`, `digests`, `agent-rules`, `usage`; `privacy-settings`; `audit` and `notification` changed | Every rule of §12 the schema holds, tested by trying to break it |
| **M2** | The contract (§9): types, the operations declared with schemas, the gates, the `agent` caller with its audience, `readerOf` for an audience, live updates per reader; **the settings' registry** (§8.1) with its defaults, `effective`, what tightening does, and the privacy page | Gates tested for two people and a third outside; each setting's property test passes at its strictest |
| **M3** | **People talk**: conversations without an assistant, in the app — start, add with or without history, leave, read, search, notifications | Anna and Erik chat in the app; Erik added without history cannot find message 1 |
| **M4** | Turns without a model: the scripted model of the evals answers, uses tools, asks; the trace, the timeline's links, one turn at a time, stop | A shared conversation's turn acts for its asker and is refused a read beyond its audience |
| **M5** | Memory: remember, offer, notice, confirm, replace, forget; the memory page; recall by words and by subject, and by meaning with a test embedder; erasure | Anna's private memory never reaches a turn whose audience includes Erik |
| **M6** | Errands' records: proposed, granted, the grant checked by the gate, wakes, their automations, budgets, the end | An errand on the fast clock acts within its grant and is refused outside it |
| **M7** | The configuration file's version: assistants, providers, models, roles, rules, the family's memories; a person's own export | Exported, reset, imported: the assistant as it was |

PLAN-AI.md's AI0–AI2 follow M2; AI3 (the model port) can begin beside M3.

## 14. Decisions for the owner

What a family decides for itself is a setting (§8.1); these are the
decisions about the model, and the defaults the settings start from.

1. **People-only conversations** — a family's own chat, the assistant
   invited when wanted (recommended) — or conversations always with it?
2. **One assistant per conversation, several per family** (recommended)?
3. **Authority and audience**: acts as the asker, says what everyone
   present may know (recommended)? This is a rule, not a setting: it is
   what makes a shared conversation safe to share.
4. **The defaults** in §8.1's table — the tighter choice wherever the
   looser costs a person something they would not expect (someone added
   sees no history; no reading along; memories private; noticed memories
   unused until confirmed; children's conversations private; audio never;
   no yes by voice) and the looser where it only costs convenience
   (conversations kept a year; local network models allowed)?
5. **Which settings a person may set for themselves** beyond the family's
   (§8.1's table), and that an admin can never loosen a person's own
   (recommended)?
6. **Embeddings**: an `embed` model, local by default — a small multilingual
   one on the models service — and recall by words alone without one
   (recommended)?
7. **The file** carries the family's memories, never a person's, and
   every privacy setting, a person's own included (recommended)?
8. **Money** counted in millionths of a US dollar, as providers price
   (recommended)?
9. **Sealing a person's private memories** so the server's operator cannot
    read them: later, as its own design (recommended), or now?
