# The assistant: kraftverk, AI-first — research, and a plan

**Status:** research and a plan, 2026-10-09. Nothing here is built beyond
what §2 lists as there already. It grows the "assistant, minimum" (an MCP
endpoint, the world snapshot, proposals that watch) into what the owner
asked for: an assistant in kraftverk itself, in the app, on the phone,
spoken to or written to, on any model the family chooses — the home's own
local models first, with nothing leaving the house —
that knows all of kraftverk, answers anything a person could find out,
does anything a person may do through the same gate, writes automations
and scripts, takes on errands that last a while, can be asked for inside
an automation, and in time extends kraftverk's own code and deploys it
while the conversation goes on.

It is built the way the rest of kraftverk is: **the model first**, then
what describes it, then the gate, then the parts that use it, each in a
shared package that runs wherever a home runs.

Where this departs from [PROPOSITION.md](PROPOSITION.md) — it said no
voice, no scripting language, and no rules a model writes — the owner's
asks since then decide: scripts are built, the language checks and
rehearses what anyone writes, and voice is wanted.

## 1. What the owner asked for

1. **An assistant in kraftverk**, on the phone, the web and the server:
   open the app and talk or write to it. "What's the charge?" "Where is
   Anna?" "Turn on the plug in this room." "Set up a charging cycle for
   my bike, like this."
2. **Voice**: speak, and hear it answer — English and Swedish.
3. **Any model**: Claude, OpenAI, Gemini, and local models on the home's
   own server; the family chooses. Not locked to one vendor, and **not
   everything MCP**: a first-class architecture of kraftverk's own.
4. **It understands all of kraftverk**: the data model, the paths, the
   API, the automation language in its whole breadth. Everything described
   well enough that *any* agent learns it quickly.
5. **Everything controllable by AI**: the whole API, under the same rules
   a person is under.
6. **Errands**: "Tomorrow, make sure my bike is charged." The assistant
   takes it on and acts on it, on the server, for a stated time, then
   reports.
7. **AI inside the automation language**: an automation can ask a model
   something as one of its steps, or hand a goal to the assistant.
8. **Self-extension**, long term: "I want an integration for my
   speakers" — "Shall I build it into kraftverk?" — it writes the code,
   the checks pass, it deploys a new version, while the conversation goes on.
9. **Local models first-class.** kraftverk keeps a home's private life;
   a family that can run its models at home must get an assistant as good
   as the hardware allows, with nothing leaving the house — not a cloud
   assistant with a local option.

## 2. What is there already

The survey of the code (2026-10-09) found more than a start.

**Built, and right:**

- **One interface, everywhere.** `KraftverkApi`
  (`packages/api-contract/src/api.ts`) is everything a home answers: 151
  operations, each with a sentence. The hub answers it in process
  (`hub.as(caller)`), the server over HTTP, the app's own worker with no
  server. An assistant over `KraftverkApi` runs wherever a home does.
- **A gate that knows an agent.** `GATES` (`packages/hub/src/api/gate.ts`)
  names every operation's rule: `read`, `act`, `scripted`, `people(…)`,
  `admins(…)`, `noScript(…)`. A caller `{ kind: 'agent' }` passes no role
  check and can never send a person's yes; a `needs-yes` comes back to it
  as a refusal in words.
- **A gateway made for untrusted actors.** Consequence declared on
  capabilities, a yes bound to one intent for a minute, the reserve, an
  agent's 60 s dwell, fresh readings, read-back, the audit; writes that
  could damage hardware are never an agent's.
- **Observe before arm.** An automation an agent makes only watches
  (`automation.proposed` on the timeline) until a person lets it act;
  rehearsal walks up to 14 days of history.
- **A language described once.** `packages/automation/src/kinds/`
  generates the checker, the words, YAML both ways, the JSON Schema, the
  editor's blocks and `REFERENCE.md` with tested examples.
- **Code a model can write, safely.** `scripts.check` and `scripts.run`
  take unsaved TypeScript and run it in QuickJS through the gate, with
  limits, answering its log, its answer and the yeses it would need;
  `scripts.types()` gives the home's `kraftverk.d.ts`, every device,
  person, room, mode and variable typed by name.
- **History** at a minute, an hour and every change; a room's history
  whatever sensor it was; runs and the timeline — all `read`.
- **Presence that keeps each person's sharing**: `presence.list()` answers
  home, place and room, never coordinates, as far as each person shares.
- **The assistant, minimum**: `GET /world` and `GET /vocabulary` for a
  model, MCP at `POST /mcp` with ten hand-written tools
  (`packages/hub/src/assistant/mcp.ts`), `propose` from a recipe and
  `rehearse`.

**Missing:**

1. **No credential for an agent**: an MCP client carries a person's
   cookie, and the agent's `for` is an account's user name, not a person.
2. **No policy per home** for agents (allowed, asked, never) and no budgets.
3. **No way to ask a person**: a refusal for want of a yes ends there; nothing
   reaches the person to say yes to.
4. **The world snapshot is devices only**: no people, presence, rooms,
   placement, labels, modes, variables or automations — "Where is Anna?"
   and "the plug in this room" cannot be answered from it.
5. **The API is not described as data**: types and sentences, no runtime
   schema (zod only in the server's routes), no OpenAPI. Tools for the
   whole API cannot be generated.
6. **Authoring over MCP is recipes only**; scripts are type checked only
   in the editor's worker.
7. **No model, no conversation, no voice, no chat** in the app.
8. **Integrations live only in the repository**: an agent that writes one
   must go through git, the checks and a deploy.

## 3. What the research found

Seven studies, 2026-10-09: model-agnostic tool calling; the libraries and
routers for many models; voice and Home Assistant's assistant; Wispr Flow
and a voice that answers; local models first-class; agents that change
their own code, and security; memory, presence privacy and proactive
assistants. The sources are kept with each finding below.

### 3.1 Talking to any model

- **The wire formats have drifted apart.** OpenAI's Chat Completions is
  what every local server speaks (Ollama, llama.cpp, LM Studio, vLLM,
  MLX), but OpenAI's own newer models refuse tools there with reasoning on;
  new work is on the **Responses API**, which "Open Responses" turns into
  a multi-vendor spec (Ollama, vLLM, LM Studio, OpenRouter — not
  Anthropic or Google). Anthropic's **Messages** keeps what a common layer
  loses: cache breakpoints, thinking that must be handed back, strict
  tools, tool search. Google's **Interactions API** replaced
  `generateContent` in June 2026.
  ([OpenAI migration](https://developers.openai.com/api/docs/guides/migrate-to-responses),
  [Open Responses](https://www.openresponses.org/),
  [Gemini Interactions](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/capabilities/interactions/developer-guide))
- **Libraries and routers that solve "many models"** (surveyed
  2026-10-09; downloads are npm's last week):

  | What | Kind | Weight, today | For kraftverk |
  | --- | --- | --- | --- |
  | **OpenRouter** | A hosted router: one key, hundreds of cloud models; OpenAI Chat (and Responses in beta, Anthropic Messages) in front; tools, reasoning and cache hints passed through; zero data retention per request | No markup on tokens, 5.5 % on credits; bring your own key 5 % above $25 000 a month; ~15 ms by its own count | **Cannot reach a model on the home's network** (private endpoints are Enterprise, and in a cloud). A good *connection* to offer — one key, every cloud model — not the architecture |
  | Vercel AI Gateway, Cloudflare AI Gateway, Requesty | Hosted routers like it | — | The same: a base address and a key |
  | **Vercel AI SDK** (`ai` 7, `@ai-sdk/*`) | The most used library: an agent loop, UI hooks, a provider per vendor | 29 M (`ai`), 15 M per provider; its provider spec went V2 → V3 → V4 in 13 months | The strongest alternative: its providers can be used without its loop (`doStream`). Against: the churn, zod as a peer, polyfills on Hermes not proven on a device, an approval flow of its own beside the gate |
  | `@earendil-works/pi-ai` (was `@mariozechner/pi-ai`) | One streaming API cut **by wire protocol**, hand-over between providers mid-conversation | 6.8 M (mostly its coding agent); renamed this year | Closest in spirit; wraps the vendors' SDKs (heavy, Node-flavoured). Read for its edge cases, not depended on |
  | TanStack AI | Adapters per activity, tool approvals | 0.5 M, before 1.0 | Too young |
  | LangChain.js, Mastra, Genkit, Effect AI, LlamaIndex.TS | Frameworks | Heavy; server-only; LlamaIndex.TS archived | No |
  | `openai`, `@anthropic-ai/sdk`, `@google/genai`, `ollama` | Each vendor's own | `@google/genai` pulls auth, `ws`, protobuf | Not needed: the wire protocols are small |
  | LiteLLM, Bifrost, Portkey Gateway | Gateways run on the home's server | LiteLLM: Python, 0.5–2 GB, a PyPI compromise in March 2026; Bifrost: one Go binary; Portkey: bought by Palo Alto | Not shipped or required; any one a family runs is one more address to the Chat adapter |

  **What settles it**: local servers now speak *more than one* protocol —
  Ollama (0.14+), llama.cpp's server and LM Studio (0.4.1+) answer
  Anthropic's Messages as well as OpenAI's Chat; Ollama a stateless
  Responses. So the adapters are cut **by wire protocol, not by vendor**,
  and every router, gateway and local server is a preset on one of them.
  ([OpenRouter](https://openrouter.ai/docs/faq),
  [its BYOK](https://openrouter.ai/docs/guides/overview/auth/byok),
  [AI SDK 7](https://vercel.com/blog/ai-sdk-7),
  [Expo guide](https://ai-sdk.dev/docs/getting-started/expo),
  [pi-ai](https://github.com/earendil-works/pi/tree/main/packages/ai),
  [Ollama's Messages](https://docs.ollama.com/api/anthropic-compatibility),
  [llama.cpp's Messages](https://huggingface.co/blog/ggml-org/anthropic-messages-api-in-llamacpp),
  [LiteLLM compromise](https://securitylabs.datadoghq.com/articles/litellm-compromised-pypi-teampcp-supply-chain-campaign/))
- **Schemas differ per provider**: OpenAI's strict mode wants every field
  required (optional as `null`); Anthropic's strict tools allow optional
  fields but no numeric bounds; Gemini fails on keywords it does not take
  and mishandles `$ref` and `[T, null]`. One canonical subset of JSON
  Schema, compiled per provider, and the meaning checked by kraftverk
  itself. ([OpenAI](https://developers.openai.com/api/docs/guides/structured-outputs),
  [Anthropic](https://platform.claude.com/docs/en/build-with-claude/structured-outputs),
  [Gemini issue](https://github.com/mlflow/mlflow/issues/26359))
- **Local models**: on Home Assistant's own benchmark for controlling a
  home, the best 12–30B open models are within 5–8 points of the frontier
  (gemma4-26b-a4b 86, qwen3-30b-a3b 84, gemini-2.5-pro 91). Writing
  automations and code is much harder for them. On a NUC without a GPU
  reading the prompt is the cost: a 4 000-token prompt is about 20 s cold
  on a 30B mixture-of-experts model; with a GPU, under a second.
  ([home-assistant-datasets](https://github.com/allenporter/home-assistant-datasets/tree/main/reports),
  [ik_llama.cpp](https://github.com/ikawrakow/ik_llama.cpp/discussions/666))
- **Code instead of many tools.** Cloudflare's *Code Mode*, Anthropic's
  *code execution with MCP* and *programmatic tool calling*, CodeAct, and
  an August 2026 study on BFCL v4: strong models do better writing code
  against a typed API than calling tools one by one (fewer tokens, more
  right); small and older models do worse. kraftverk's scripts —
  QuickJS, a typed SDK per home, the gate under every call — are exactly
  that pattern. ([Code Mode](https://blog.cloudflare.com/code-mode/),
  [Anthropic](https://www.anthropic.com/engineering/code-execution-with-mcp),
  [CodeAct](https://arxiv.org/abs/2402.01030),
  [The Bitter Lesson of Tool Calling](https://arxiv.org/abs/2608.06370))
- **Teaching a large system**: few coarse tools with names, not ids;
  errors that say how to fix them; knowledge loaded when needed (Agent
  Skills — a name and a line up front, the body on demand, now an open
  standard); a tool to search tools; a stable prefix for the prompt cache;
  and for a language: a reference, a few similar examples, and a validator
  whose structured problems the model corrects in a loop.
  ([Writing tools](https://www.anthropic.com/engineering/writing-tools-for-agents),
  [Context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents),
  [Agent Skills](https://agentskills.io))
- **MCP** (spec 2026-07-28: stateless, `server/discover`, OAuth) is the
  door for *outside* agents — Claude Desktop, ChatGPT, Codex — not the
  inside of an assistant. ([changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog))
- **Evaluation**: tasks from real failures, graded on the final state by
  code, reported as pass^k (right *every* time of k), across models.
  ([Anthropic on evals](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents),
  [τ²-bench](https://arxiv.org/abs/2506.07982))

### 3.2 Home Assistant, and the others

- **Home Assistant 2026.10**: a pipeline of wake word → speech to text →
  a conversation agent → text to speech, each swappable. Sentences matched
  exactly first, the model only for what is not understood. Tools carry
  `read_only`, `destructive`, `idempotent`; the prompt lists exposed
  entities *without* state, and the model asks for state with a tool.
  Text to speech starts while the model still writes (first audio 5.3 s →
  0.56 s). MCP both ways. Its gaps: no confirmation for dangerous things
  yet (the workaround is to expose a script that can only lock), no idea
  of which room a phone is in, and complaints of latency (minutes on a CPU
  with a local model) and of the wrong device switched.
  ([LLM API](https://developers.home-assistant.io/docs/core/llm/),
  [2026.10](https://www.home-assistant.io/blog/2026/10/07/release-202610/),
  [voice chapter 10](https://www.home-assistant.io/blog/2025/06/25/voice-chapter-10/))
- **Alexa+, Gemini for Home, Siri with App Intents, Homey, SmartThings**:
  all now a model with tools; all criticised for latency and for doing
  "fairly random things". Siri confirms before intents with side effects
  on its own; Homey shows a model a few tools and lets it search the rest.

The lesson: matching first and the model second, state behind a tool, and
**the place a person is a fact the app gives, never a guess**.

### 3.3 Voice

| Stage | On the phone | On the home's server | In the cloud |
| --- | --- | --- | --- |
| Speech to text | iOS SpeechAnalyzer / SFSpeechRecognizer; Android SpeechRecognizer; the browser's Web Speech — free, streaming, Swedish to be confirmed per device | **KB-Whisper** (the Swedish National Library's Whisper: 5.4 % word errors in Swedish, better than OpenAI's large-v3) on faster-whisper; about 1 s for a short command on a small CPU at `small`; Parakeet, Moonshine for English | Deepgram, ElevenLabs Scribe, Soniox, OpenAI — streaming, Swedish, about $0.005 a minute |
| Text to speech | The platform's voices (Swedish on both), a sentence at a time | **Piper** with Swedish voices (Alma, nst, lisa; GPL engine, run as its own process); Chatterbox with a GPU | ElevenLabs Flash, OpenAI, Gemini |
| Speech to speech | — | open models not ready (tools still in progress) | OpenAI Realtime, Gemini Live — fastest and most natural, but one vendor, cloud only, 5–20× the cost, tools less reliable |

- **Speaches** serves Whisper, Piper and Kokoro behind OpenAI-compatible
  endpoints (`/v1/audio/transcriptions`, `/v1/audio/speech`, `/v1/realtime`).
  ([Speaches](https://github.com/speaches-ai/speaches),
  [KB-Whisper](https://huggingface.co/KBLab/kb-whisper-large),
  [Piper](https://github.com/OHF-Voice/piper1-gpl))
- A chain (speech → text → model → speech) keeps the model a choice, the
  log in words, and every action the same; it reaches first audio in 1–2 s
  when each stage streams. Production systems still mostly chain.
- **Barge-in** (speaking over the answer) needs the phone's echo
  cancellation with the speech played through the same audio engine;
  **Silero VAD** finds where speech ends, in the browser and on the phone.
- **Wake words** are for later: on a phone, push to talk; Porcupine's free
  tier ended in June 2026, openWakeWord's models are non-commercial.

**Wispr Flow** is dictation that types into any text field: a keyboard on
iOS (it opens its own app a moment to take the microphone), a floating
bubble on Android, apps on Mac and Windows. Everything is processed in the
cloud, in the US; Swedish is among its 100+ languages but not among the
seven it says are as good as English; no retention only with *Privacy
Mode* on **and** *Cloud Sync* off. Its developer API is "by exclusive
access" and takes no new partners — so an adapter for it is not possible
today. Aqua Voice is the one dictation product with a public API
(OpenAI-compatible, batch). ([Flow keyboard](https://docs.wisprflow.ai/articles/7453988911-set-up-the-flow-keyboard-on-iphone),
[its API](https://api-docs.wisprflow.ai/quickstart),
[its privacy](https://wisprflow.ai/enterprise-privacy),
[languages](https://wisprflow.ai/research/supporting-languages))

**A voice that answers** — the state of the art, October 2026:

- **Cloud**: ElevenLabs v4 and v4 Turbo lead the blind rankings (Artificial
  Analysis' Speech Arena), with Qwen's, Cartesia Sonic 3.6 and Gemini 3.8
  Flash TTS close behind; all speak Swedish (Turbo and Sonic 3.6 to be
  confirmed). Cartesia takes text best as it streams in; Gemini is the
  cheapest and watermarks every word (SynthID); Azure's Swedish voices
  (Sofie, Mattias, Hillevi) are plainer but exact with SSML and in an EU
  region. OpenAI's `gpt-4o-mini-tts` retires in January 2027; Hume has no
  Swedish. ([leaderboard](https://artificialanalysis.ai/text-to-speech/leaderboard),
  [Eleven v4](https://elevenlabs.io/blog/eleven-v4),
  [Gemini TTS](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash-tts),
  [Cartesia](https://docs.cartesia.ai/build-with-cartesia/capability-guides/stream-inputs-using-continuations))
- **Local**: in Swedish the choice is short. **Piper** (alma, nst, lisa)
  runs on any CPU and on the phone through sherpa-onnx, at a medium
  quality; **Chatterbox Multilingual v3** (MIT, watermarked) is good with a
  GPU and clones one voice from ten seconds; Kokoro, Kyutai, NeuTTS and
  the rest have no Swedish, and the best open voices are non-commercial.
  ([Chatterbox](https://www.resemble.ai/resources/chatterbox-multilingual-v3-tts-with-embedded-watermarking-for-25-languages),
  [sherpa-onnx for React Native](https://github.com/XDcobra/react-native-sherpa-onnx))
- **The phone's own**: iOS's Swedish Alva, Klara and Oskar in *Enhanced*
  quality (downloaded in Settings), Android's Google voices — acceptable,
  robotic in Swedish; `expo-speech` takes a sentence at a time, no SSML.
- **One voice, many engines**: a persona written as data (its name, its
  register, a paragraph of style for the engines that take one) and a
  voice per engine standing in for it; one multilingual voice for both
  languages, so it is the same person in Swedish and English.
- **Said for the ear**: one or two sentences, the outcome first, the rest on
  screen; numbers and units normalised by kraftverk before any engine —
  "80 %" as *åttio procent*, "1,2 kW" as *en komma två kilowatt* — never an id.
- **Cloning a family member's voice** is biometric data under the GDPR:
  only with that person's own recorded, revocable consent, never a child's,
  and always said to be an AI. ([analysis](https://sota.io/blog/voicestudio-self-hosted-voice-cloning-gdpr-article-9-biometric-data-developer-guide-2026))
- **The EU AI Act, Article 50** (in force since 2026-08-02): a system that
  talks to people says it is an AI; synthetic audio is marked so it can be
  detected. ([guide](https://artificialintelligenceact.eu/transparency-rules-article-50/))
- **Streaming**: the answer cut into sentences (the first short), minding
  abbreviations and the Swedish decimal comma; under a second of audio
  queued, so speaking over it stops it at once and only the words heard are
  kept in the conversation; fixed phrases ("Klart.") cached as audio.

### 3.4 Local models, first-class

- **Good enough for a home, already.** On Home Assistant's leaderboard,
  Gemma 4 26B-A4B scores 98.0 on the small control set (Gemini 2.5 Pro
  98.5), 86.3 on the large one (91.3) and **83.3 on writing automations**
  (76.7). The gap opens with many devices and many tools, with small
  models, and in Swedish. ([leaderboard](https://github.com/allenporter/home-assistant-datasets/tree/main/reports))
- **Swedish**: on EuroEval's Swedish board the best open models are Gemma 4
  31B, Mistral Small 3.1 and Gemma 4 26B-A4B; among small ones Qwen3.5-9B,
  Ministral 3 8B, Gemma 4 E4B and Qwen3.5-4B. No home-trained small model
  (home-llm, hua-1.7b) speaks Swedish. ([EuroEval](https://raw.githubusercontent.com/EuroEval/leaderboards/main/leaderboards/swedish_all_simplified.csv))
- **What the hardware allows** (October 2026):

  | The home's server | Commands and `ask:` | Conversation, errands | Writing automations | Speech to text |
  | --- | --- | --- | --- | --- |
  | Raspberry Pi 5 | Matching only | Another machine, or a cloud by choice | — | Another machine |
  | N100, 16 GB, no GPU | Matching + Qwen3.5-4B, its prefix cached | Short, the same 4B | The 4B under a grammar, or a cloud by choice | KB-Whisper base |
  | Core Ultra or Ryzen, 32–64 GB | Qwen3.5-4B | **Gemma 4 26B-A4B** | Gemma 4 26B-A4B under a grammar | KB-Whisper small |
  | A Mac, 16 / 32 / 64 GB | Gemma 4 E4B | E4B / 26B-A4B / 31B (natively; Docker has no Metal) | the same | small or medium |
  | NVIDIA 12 / 16 / 24 GB | Qwen3.5-9B | Gemma 4 12B / gpt-oss-20b / Gemma 4 31B | 26B-A4B; a Qwen 27B for TypeScript | large, ~0.2 s |
  | The phone, no server | Matching + Apple's on-device model (Swedish since iOS 26.1, tools, 4 096 tokens) or a 2–4B model through llama.rn | — | — | The phone's |

  On a CPU, **reading the prompt** is the cost (a 4B model with 2 500
  tokens of context can take seconds): a prefix kept byte-for-byte the same
  and cached is what makes it usable. 4-bit quantisation keeps the shape of
  a call but doubled calls to tools that do not exist in one study: Q5–Q6
  for roles that act, where memory allows.
  ([Core Ultra](https://github.com/ggml-org/llama.cpp/discussions/23313),
  [quantisation](https://arxiv.org/html/2607.27275v1),
  [Apple's languages](https://www.macrumors.com/2025/09/22/ios-26-1-apple-intelligence-languages/),
  [llama.rn](https://github.com/mybigday/llama.rn))
- **The runtimes** all speak OpenAI's Chat; most also Anthropic's
  Messages. For managing models, **Ollama** has the best API (pull with
  progress, what is loaded and in which memory, delete); **llama.cpp's
  server** has a router mode that loads, unloads and evicts models, and a
  grammar for any output; LM Studio, LocalAI and AMD's Lemonade can
  download; vLLM, SGLang and MLX cannot. Home Assistant's own integrations
  only point at a server and manage nothing; an add-on that ran the model
  inside Home Assistant broke on its upgrades.
  ([Ollama pull](https://docs.ollama.com/api/pull),
  [llama.cpp's router](https://huggingface.co/blog/ggml-org/model-management-in-llamacpp))
- **Closing the gap**: matching first (Home Assistant's way; it has no
  Swedish matcher worth the name); decoding held to a grammar or schema (as
  accurate or better, always well-formed — but llama.cpp has bugs where a
  grammar is quietly dropped, so kraftverk checks every answer anyway);
  few tools, found by retrieval (one study halved the prompt and lifted a
  1.1B model to GPT-4's level on its task); a small model for commands and
  a larger for writing; a repair loop on the checker's problems.
  **Fine-tuning a small model on kraftverk's language** works in published
  studies (fine-tuned 4–12B models beat GPT-4 on a domain language), at the
  cost of tens of thousands of checked examples and a retrain each time the
  language changes — later, not while it is strict version 1.
  ([JSONSchemaBench](https://arxiv.org/abs/2501.10868),
  [TinyAgent](https://arxiv.org/abs/2409.00608),
  [NL to DSL](https://arxiv.org/abs/2604.09952))
- **A local address is not local inference**: Ollama can forward to its
  cloud models, LiteLLM and LocalAI to theirs, a private address may be a
  VPN. Only a runtime whose own traffic out is shut can be called sealed.

### 3.5 Agents that change their own code

- **Coding agents run headless**: the Claude Agent SDK (TypeScript;
  permissions, hooks, subagents, a sandbox; Claude only, proprietary
  terms); OpenAI's Codex SDK (Apache; other models through a translating
  proxy); **opencode** (MIT; a headless HTTP server with a TypeScript SDK;
  75+ providers and local models; no sandbox of its own); OpenHands,
  Goose, Cline. Every one is a process of its own, never inside the hub.
  ([Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview),
  [hosting](https://platform.claude.com/docs/en/agent-sdk/hosting),
  [opencode server](https://opencode.ai/docs/server/))
- **What went wrong elsewhere**: Replit's agent deleted a production
  database during a code freeze it had been told of; the fix was a wall,
  not a prompt — separate databases, deterministic migrations. OpenClaw's
  skills, live the moment they were written, grew a marketplace with
  hundreds of malicious ones. Skills a model writes for itself scored
  *worse* than none on one benchmark.
  ([Replit](https://www.kpath.ai/learn/incidents/replit-production-database-deletion),
  [Unit 42](https://unit42.paloaltonetworks.com/openclaw-ai-supply-chain-risk/),
  [SkillsBench](https://huggingface.co/papers/2602.12670))
- **What works**: the agent in its own container with its own clone and a
  branch, no secrets, no Docker socket, outbound traffic to a short list;
  the checks as the gate, which it can read and not change; a person
  approving the change; a deploy that checks health and rolls back by
  itself; the conversation kept outside what restarts.

### 3.6 Security, memory, and an assistant that speaks first

- **Prompt injection reaches homes**: in 2025 a calendar invitation's
  title made Gemini open shutters and turn on a boiler when the user later
  said "thanks". Device names, a vendor cloud's data, web pages, emails and
  memory are all text an attacker may write.
  ([SafeBreach, via TechRepublic](https://www.techrepublic.com/article/news-google-gemini-indirect-prompt-injection-attack/))
- **The rules that answer it**: Willison's *lethal trifecta* (private data,
  untrusted text, a way out); Meta's *rule of two* (untrusted input,
  sensitive systems, changing things — any two, all three only with a
  person); the six patterns of *Design Patterns for Securing LLM Agents* —
  above all plan-then-execute and the **dual model**, where the model that
  reads untrusted text has no tools; OWASP's agentic top 10 ("least
  agency", kill switches, validated memory).
  ([trifecta](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/),
  [rule of two](https://ai.meta.com/blog/practical-ai-agent-security/),
  [patterns](https://arxiv.org/abs/2506.08837),
  [OWASP agentic](https://genai.owasp.org/2025/12/09/owasp-top-10-for-agentic-applications-the-benchmark-for-agentic-security-in-the-age-of-autonomous-ai/))
- **Memory**: a small profile always loaded, episodes searched, a fact
  that changes replaces the old (kept with its dates), each person's own,
  visible and deletable, and never "remember: always unlock the door" from
  text the person did not say. ([Claude memory tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool))
- **Who is speaking** is not proven by a voice; a signed-in phone is.
- **Where someone is**: the person chooses what to share and with whom
  (Find My's model, not Life360's); answer at that level; say who asked.
- **Speaking first**: Alexa+'s "by the way" drew backlash; what works is
  rare, grouped, with its reason and a "stop telling me this", and
  deterministic triggers deciding *when* — the model only words it.

## 4. The architecture, from the model up

```
            app (phone, web)            outside agents         the language
     chat · voice · asks · errands     MCP · skills          ask: · errand:
                 │                          │                      │
                 └──────────┬───────────────┴──────────┬───────────┘
                            ▼                          ▼
          packages/assistant — the agent: turns, tools, context, errands, memory rules
                 │                    │                         │
     packages/llm (any model)   packages/voice (ports)   the operations, described once
                                                          (packages/api-contract)
                                         │
                       KraftverkApi through the gate (hub.as(agent caller))
                                         │
                       the gateway — every physical act, as ever
```

Everything above the gate is a **shared package**: no Node or Bun
built-in, the platform behind a port. The hub on the server holds it by
default; the app with no server holds it too, and reaches a model from the
phone.

### 4.1 The data model

New in the family's database (`packages/store/src/schema.ts`), each table
with its reason:

| Table | What it holds | Why |
| --- | --- | --- |
| `ai_connection` | A model the family may use: a label, the wire protocol (`openai-chat`, `anthropic-messages`, `openai-responses`, `gemini`, or the phone's own), its address, the model's name, what it can do (tools, images, a cache, thinking, a grammar, how many tools), **where it runs** as last checked (*in this house, sealed*; *on your network*; *in the cloud*, with the provider), who added it | The family chooses its models; a local server is one more address, and where each runs is known, not assumed |
| `ai_model` | A model kraftverk downloaded into its own `models` service: the catalogue's entry, the file's hash, its size, the roles it passed the self-test for, when | What is on the home's server, and why it is trusted for what |
| `ai_connection_secret` | Its key, sealed, held by the node that calls it — as `connection_secret` is | Keys never in an export or the file unless chosen, never in git |
| `ai_role` | Which connection does which job: `chat`, `voice` (fast), `author` (strong: automations, scripts, code), `background` (cheap: errands' checks, digests), `step` (an automation's `ask:`); a person may choose their own for `chat` | One model for everything is wrong both ways: too slow for voice, too weak for authoring |
| `conversation` | Whose it is, which home, how it came (`app`, `voice`, `mcp`, `errand`), its title, when | Conversations survive a restart — and a deploy (§4.16) |
| `conversation_turn` | Each turn in order: who (person, assistant, tool), its content normalised, the provider's own state (thinking, signatures) kept opaque, tokens and cost | A model's state must be handed back as it gave it; usage is counted from it |
| `ask` | A request for a person's yes: from which agent (conversation or errand), to whom, the operation and its arguments, the sentence and the evidence (the receipt to be), until when, the answer and when | The missing link: an agent's `needs-yes` becomes a card the person answers; the yes is bound to that one intent, as the gateway's is |
| `errand` | A goal with an end (§4.9): for whom, which home, the goal in words, until, the plan in words, the **grant** (what it may do without asking, listed), its budget and what it has spent, its state, its outcome | An assistant acting over hours, held by the hub, not by a running model |
| `errand_automation` | The automations an errand made, ended with it | What an errand set up is visible, and goes when it goes |
| `memory` | A fact: about whom (a person, a home, the family), in words, who said it and in which conversation, who may see it (the person, the family), from when, replaced by which | Personal, visible, deletable; changes kept with their dates |
| `ai_usage` | Per connection, per day: tokens in and out, cost when known, per conversation, errand and automation | Budgets, and the family seeing what the assistant costs |
| `agent_policy` | Per home, per capability (or a link kind, or a part's category): `free`, `asks`, `never` — and per hour how many consequential acts | The owner's rules for agents, over the gateway's own |

In `node.db`, beside the sign-ins: **`agent_token`** — a token for an
outside agent (an MCP client): for which person, a label, its hash, when it
was last used, revoked or not.

**The caller** says which agent, for whom, and how:

```ts
| { kind: 'agent'; for: string /* a person's id */; name: string; via: 'app' | 'voice' | 'mcp' | 'errand' | 'step'; conversation?: string; errand?: string }
```

so the timeline says *"The assistant, for Anna, by voice: turned on Bike
plug"* and every receipt leads back to the conversation or errand it came
from. `for` becomes a person's id everywhere (today an account's user name).

**The configuration file** carries connections (without keys), roles, the
policy and memory a person chose to keep; not conversations, asks, usage
or errands, which are what happened, not how the home is. Its version goes
up once, with a migration and a kept fixture.

### 4.2 Everything described once: the operations

The automation language's lesson — one description per construct, the rest
generated — applies to the API. Today `KraftverkApi` has types and a
sentence per method, `GATES` its rules, the server's routes their own zod,
`API.md` its table, MCP its hand-written schemas. Five copies, drifting.

**One declaration per operation**, in `packages/api-contract`:

```ts
'devices.command': operation({
  summary: 'Send a command to one part of a device, through the gateway.',
  input: z.object({ device: deviceRef, part: z.string(), capability, command: z.string(), args: z.record(…) }),
  answer: commandResult,
  gate: 'scripted',
  effect: 'acts',          // reads | changes | acts — what it does to the world
  examples: [{ say: 'Turn on the bike plug', input: { … } }],
}),
```

From it, generated: the gate table, the server's parsing and its errors,
the assistant's tools, the MCP tools, an OpenAPI document, `API.md`'s
table, and a reference an agent loads. The compiler refuses an operation
with a piece missing, as the language's registry does. zod 4 (already the
server's) writes JSON Schema itself; one canonical subset is compiled per
provider (§3.1) by `packages/llm`.

**What an agent may never call** stays a list, checked by the architecture
test: signing in and accounts, keys and recovery, secrets and exports with
secrets, resetting, the nodes, forgetting a person. A new operation is a
decision, not an accident — as it is for scripts.

### 4.3 The world, as a model reads it

The snapshot grows from devices to the world, in **two layers**:

1. **The index** — always in the prompt, stable so it caches, a few
   hundred tokens for a home: the family, its homes, rooms by floor, people
   by name, devices by name with their room and kind, modes, variables,
   automations by name. Names, not ids; no live values (they would break
   the cache, and would be stale).
2. **The look** — by tool, live: a device's readings with freshness and
   meaning, a room's state, who is where (as far as each shares), what a
   variable holds, what an automation did, what happened.

**"This room", "here", "me"** are facts the app gives with each turn, never
guessed: the screen open (a room, a device), the home chosen, and where the
person is when they share it (`spot`, presence). The assistant answers
"which room?" when none is known.

### 4.4 Knowledge for any agent: skills

What an agent must know is **generated**, in the Agent Skills format, so
kraftverk's own assistant, Claude Code, Codex or any MCP client loads the
same pages — a name and a line up front, the rest when needed:

| Skill | From | Holds |
| --- | --- | --- |
| `kraftverk-home` | The world model, `DATA-MODEL.md` | What families, homes, spaces, people, devices, parts, capabilities, meanings, links, modes and variables are, and how to read them |
| `kraftverk-automations` | The language's registry, `REFERENCE.md` | Every trigger, condition, step and function with its tested examples, the YAML, and the loop: draft → check → rehearse → create watching → a person lets it act |
| `kraftverk-scripts` | `packages/script`, the home's `kraftverk.d.ts` | The SDK, typed by this home, served live |
| `kraftverk-devices` | The capability library, meanings, links | What each capability's commands take, and what makes one consequential |
| `kraftverk-api` | The operations (§4.2) | Every operation by namespace, with its examples |
| `kraftverk-code` | `AGENTS.md`, `ADDING-A-DEVICE.md`, the package READMEs | For the builder (§4.16): how kraftverk is changed |

They are written by `npm run gen:skills`, checked current by
`check:architecture`, served at `/api/skills`, and offered over MCP. The
same pages teach a person.

### 4.5 The gate for agents

The gate and the gateway stay the policy; the model is an untrusted actor
and is never the place a rule lives.

| Tier | What | An agent |
| --- | --- | --- |
| Read | Anything a `read` operation answers, as far as the person it acts for may see (presence at each person's sharing) | Freely |
| Act | Commands no capability calls consequential: a lamp, a volume | Freely, unless the home's policy says `asks` |
| Consequential | What the gateway already asks a person's yes for: mains cut under load, the reserve, a link's source; and whatever the policy says `asks` | Asks (§4.6), or within an errand's grant |
| Never | Writes that could damage hardware; what §4.2 lists | No tool exists |

On top: **budgets** (consequential acts per hour, tokens and cost a day),
**the dwell** the gateway already keeps, a **stop** that ends every errand
and conversation at once, and the **audit** naming the conversation or errand.

**Untrusted text is marked**: device names, an integration's data, a
web page, a message body are given to a model as quoted data, and the
assistant reads them **before** it has decided what to do only in a turn
without tools that act — the dual model (§3.6). Memory is written only from
what a person said, in their own conversation.

### 4.6 Asking a person

An agent that needs a yes makes an **ask**: the operation and its
arguments, a sentence, the evidence (the reading now, what it will do, the
receipt to be), whom, until when. The person sees it — in the conversation
as a card, and, when they are not there, as a notification with *Yes* and
*No*. Their yes runs the operation **as them**, bound to that intent; a
change in the world since (a stale reading, a different load) asks again.
An ask that expires is a no. Voice never says yes to a consequential act:
it is said on a signed-in screen.

### 4.7 The model port, and local models first-class: `packages/llm`

A thin port, kraftverk's own, over **wire protocols**, with nothing but
`fetch`, a stream and a small reader of server-sent events — no vendor's
SDK. The libraries (§3.1) own a loop, carry weight that will not run in
Hermes, and change faster than the protocols they wrap; and the part that
differs per provider — thinking handed back, cache breakpoints — is the
part a common layer flattens. The stream's events borrow the AI SDK's
vocabulary (text, reasoning, tool input, tool call, the end with usage),
and its adapters (Apache-2.0) and pi-ai's (MIT) are read as reference.

- **One message shape**: text, an image, a tool call, a tool's answer — and
  an opaque `providerState` per turn, handed back as it came (thinking,
  signatures, encrypted reasoning).
- **One stream of events**: text, tool call (begun, arguments, done),
  thinking, usage, the end and why.
- **What a model can do**, declared per connection: tools at all, several
  at once, strict schemas, a prompt cache, thinking, images, how many
  tools before it gets worse.
- **Adapters by protocol**, in this order:
  1. **OpenAI Chat Completions** — every local server (Ollama, llama.cpp,
     LM Studio, vLLM, MLX), OpenRouter, Groq, Together, any gateway: an
     address and a key. A small table of dialects (where each puts its
     reasoning), and tolerant of their faults (calls keyed by id, ids made
     when missing, shapes validated after strict decoding).
  2. **Anthropic Messages** — Claude with thinking and its signatures and
     cache breakpoints exact; also Ollama's, llama.cpp's and OpenRouter's
     `/messages`.
  3. **OpenAI Responses** — OpenAI's reasoning models, their encrypted
     reasoning and cache keys.
  4. **Gemini**, later — its OpenAI-compatible address stands in until then.
- **Connections are presets on a protocol**: *Ollama on this server*,
  *llama.cpp*, *LM Studio*, *OpenRouter* (its zero-retention flag, a
  session for the cache, fallbacks as options), *Anthropic*, *OpenAI* —
  each an address, a protocol, a key or none.
- **Schemas compiled per provider** from the one canonical subset.
- **The platform gives `fetch`** and a WebSocket; the phone calls a cloud
  model or a local server on the home's network itself.
- **On the phone itself**: adapters for Apple's on-device model and for
  llama.rn, behind the same port, for commands with no server and no cloud.

**Local, first-class.** Not a cloud assistant with a local option: the
home's own models are the default wherever the hardware carries them, and
kraftverk does the work a family would otherwise do by hand.

- **A `models` service kraftverk ships**, optional, in its Compose file:
  llama.cpp's server in router mode (images for CPU, CUDA and Vulkan) and
  a speech server (Speaches: KB-Whisper and Piper), on a network of their
  own **with no way out**. kraftverk downloads models into its volume
  itself — resumed, checked against a hash, from a source it shows — and
  loads them. On a Mac, where Docker has no GPU, the same through a native
  Ollama or LM Studio.
- **Ollama managed as well**: a family that already runs it sees its models
  in Settings, pulls one with progress, sees what is loaded and where,
  removes one — through Ollama's own API.
- **A catalogue kraftverk keeps** — model, quantisation, size, the roles
  it is recommended for, its hash — and **the hardware read** (memory,
  graphics memory, the GPU's kind): Settings proposes what fits, *"Gemma 4
  26B for conversation and writing (17 GB), Qwen3.5-4B for commands
  (3 GB)"*, and the family says yes.
- **Recommended only by evidence**: a model is recommended for a role
  only when it passes that role's evals (§4.17) — commands, `ask:`,
  conversation, writing, errands — in Swedish and English, on the
  runtime and quantisation the family would run. After a download the
  family's own server runs a short self-test, which also catches a broken
  chat template.
- **Made good despite being smaller**: matching first, in Swedish and
  English; few tools and the rest found when needed; output held to a
  grammar generated from the language's own registry (the JSON Schema it
  already writes) and checked anyway; the prompt's prefix kept identical so
  the runtime's cache holds it; a small model for commands and a larger for
  writing; a repair loop on the checker's problems.
- **Every role local by default**, a cloud model only for a role the family
  names (§4.14).

### 4.8 The assistant: `packages/assistant`

**A turn**: the stable prefix (who it is, the rules, the skills' first
lines, the tools, the home's index) → the conversation → the person's words
and the app's facts (§4.3) → the model → tools → the answer, streamed. Long
conversations are compacted; tool answers are short by default with a
`detail` switch; every refusal is a sentence that says what would work.

**Matching first.** A small matcher in the package answers the commonest
things without a model — "turn on/off X", "what is X", "where is P", in
English and Swedish, from the home's own names — and gives the rest to the
model. Measured by the evals (§4.17): kept only where it is right more
often than the model and faster.

**Tools, in two rings:**

1. Always there (small models and voice need few): `look` (find a device,
   room, person, automation by words, with live values), `read` (a value,
   a history, what happened), `act` (a command, an intent: device, part,
   capability, command, arguments), `where` (a person, at their sharing),
   `set` (a mode, a variable), `ask` (a person's yes), `remember`, `errand`.
2. Found when needed: `find_operations` and `call` over every operation an
   agent may call (§4.2); `automation` (draft, check, rehearse, create,
   let act); `script` (check, run, save); `skill` (load one).

**Code mode** for the strong models: `run_script` with the home's
`kraftverk.d.ts` — one script instead of twenty calls, through the same
gate, with the same limits, its problems by line given back to fix. The
evals decide per model whether it is offered.

**Authoring**: "charge my bike between 20 and 80 % at night" becomes a
draft in the language → `check` → the problems fixed in a loop → the
sentence and a rehearsal on history shown → saved **watching** → the person
lets it act. Scripts the same, with a type check on the hub too (left over
in PLAN-SCRIPTS §11.2).

### 4.9 Errands: goals with an end

"Tomorrow, make sure my bike is charged." An errand is a **goal, an end,
a grant and a budget**, held by the hub — not a model left running.

1. **Taken on**: the assistant writes it out — *"Have the bike charged by
   07:00 tomorrow. I'll switch Bike plug on at 23:00, when power is cheapest,
   and off when it stops drawing. I may switch Bike plug on and off until
   07:00 without asking."* — and the person says yes. That yes is the
   grant: exactly the acts listed, until the end.
2. **Set up**: where it can, the errand **makes automations** for the part
   that waits and reacts — rehearsed, deterministic, cheap, working if the
   model is slow or gone: at 23:00 switch on; when power stays under 5 W for
   10 min, switch off and wake the errand.
3. **Woken, not running**: the model is called at the errand's own
   checkpoints — a time it set, an event it asked for, a failure, its
   automation's `wake` — with a fresh context (the goal, the plan, its
   log, the world now). It decides, acts within its grant, asks for what is
   outside it, changes its automations.
4. **Ends**: done (and how it knows), failed (and why), out of time,
   or stopped. The person is told; its automations go.

An errand is a page in the app: the goal, the plan, what it did and why,
what it spent, *Stop*. Errands are capped in length (a week) and budget.

### 4.10 AI in the automation language

Two new kinds, in the registry like every other, so they check, read as
sentences, round-trip as YAML, draw as blocks and have reference pages:

- **`ask:`** — a step that asks a model a question and gets a **typed
  answer**: yes or no, a number in a unit, one of the given choices, text.
  ```yaml
  - ask: Will today be sunny enough to charge from solar alone? {weather.forecast}
    answer: { yes or no }
    as: sunny
    otherwise: [ … ]          # the model unreachable, or an answer not of its type
  ```
  The model has **no tools**: its answer is data the rule then acts on —
  the dual model by construction, so text from a forecast or a message
  cannot make it act. Its role is `step`; a budget per automation per day;
  in a rehearsal it is unknown, said as a caveat.
- **`errand:`** — a step that hands a goal to the assistant, with an end
  and a grant no larger than the automation's own: *"When the bike is
  plugged in after 20:00: errand: have it charged by 07:00."* The
  automation's being let act is the yes.

### 4.11 Voice: text at the core, voice around it

The assistant works on text; voice is ports around it in `packages/voice`
with adapters per platform, as storage and Bluetooth are:

- **`SpeechToText`**: audio in, partial and final text out, a language
  and the home's names as hints (rooms, devices, people — Whisper mishears
  names less told them).
- **`TextToSpeech`**: sentences in as the answer streams, audio out,
  stoppable.
- **`TurnDetector`** (Silero VAD) and later **`WakeWord`**.
- **`RealtimeSession`**, optional: OpenAI Realtime or Gemini Live in place
  of all three, with the *same* tools through the same gate.

**Listening.** Speech to text on the phone (the platform's recogniser; the
browser's Web Speech), **KB-Whisper on the server** where the phone's
Swedish falls short, through an OpenAI-compatible speech server such as
Speaches. Push to talk first; barge-in with the phone's echo cancellation;
a wake word and a speaker in a room later.

**Dictation keyboards** — Wispr Flow, Apple's dictation, any other — work
because the conversation's text box is an ordinary one: never a secure
field, a whole paste taken as one insertion, the draft kept when iOS
switches to the keyboard's app and back, and the assistant's own microphone
left alone while another has it. That is what *supporting Wispr Flow* can
mean while its API is closed; Settings says plainly that such a keyboard
sends what is said to its own cloud. An adapter for it follows if the API
opens; Aqua's API fits the same port.

**Its voice.** The assistant is **one persona**, kept as data: a name, a
register (warm, brief, plain), a paragraph of style for the engines that
take one, and per engine the voice that stands in for it — one
multilingual voice where the engine has it, so Swedish and English are the
same person. Defaults by what the home has:

| | Swedish and English |
| --- | --- |
| On the phone, or a server without a GPU | **Piper** through sherpa-onnx (alma or nst, and an English voice to match), on the server or on the phone itself; the phone's *Enhanced* voices when nothing is installed |
| A server with a GPU | **Chatterbox Multilingual v3**, one voice for both languages from one consented clip; Piper as the fast fallback |
| Cloud, by choice | ElevenLabs (v4 Turbo, or Flash on its streaming socket), Gemini 3.8 Flash TTS, or Azure's Swedish voices for SSML and an EU region |

- **What is said is written for the ear** by a shared module in
  `packages/voice`: the answer's spoken form (the outcome first, a
  sentence or two; the details on screen), numbers, units, times and
  decimal commas read in the language spoken, never an id; the same text
  for every engine.
- **It says it is an AI** the first time it speaks to someone, and its
  audio is marked where the engine marks it (Article 50).
- **No cloned voice of a person** unless that person recorded it, consents
  and can take it back; never a child's.
- Falling back keeps the persona: cloud → a GPU's voice → Piper → the
  phone's, the same register throughout.

### 4.12 The app

- **The assistant on every screen**: a button that opens it over what is
  shown, so "this room" is the room on screen; hold to talk.
- **The conversation**: the answer streamed and spoken; what it did as
  short rows (*Read Bike plug: 0 W*, *Turned on Bike plug*); asks as cards
  with *Yes*/*No*; drafts as the automation's sentence with *Rehearse*,
  *Save watching*.
- **Errands**: a list and a page each.
- **Settings › Assistant**: models (add Claude, OpenAI, Gemini, or a local
  server by its address; test it), which does what, voice, the policy,
  budgets and what it has cost, what a cloud model may see, memory (read,
  correct, forget), tokens for outside agents.

### 4.13 Outside agents: MCP

`/api/mcp` stays, and becomes **generated** from the operations and the
assistant's tools (no hand-written schemas), on the 2026-07-28 spec,
signed in with an **agent token** (and later OAuth), serving the skills.
Claude Desktop, ChatGPT or Codex then reach the home on the same terms as
the assistant in the app.

### 4.14 Privacy: what leaves the house

Per family, said in Settings: which models are local and which are not,
and what a cloud model may be told — devices and readings; history;
presence (at each person's sharing, never a position); memory. Who asked
where someone was is said to that person, as Find My does.

- **Every connection says where it runs**, checked, not assumed: *in this
  house, sealed* (kraftverk's own `models` service, whose way out is shut
  and tested to be); *on your network* (an address that resolves, at every
  connection, only to private, loopback or link-local addresses, with no
  redirect or proxy — which may still be a VPN or a forwarder); *in the
  cloud* (the provider and its region).
- **Each role shows its connection**, and every call to a model is in a
  log: where to, how much, what was left out.
- **Local only** is one switch: the assistant then refuses any connection
  not *in this house* or *on your network*, and says what it cannot do.
- **A cloud model for a named role** (writing automations, say) is told the
  least the task needs: names of people, addresses and positions replaced
  by stand-ins kraftverk maps back when the answer comes, and the gate still
  checking whatever it asks to do.

### 4.15 Memory, and speaking first

- **Memory** (§4.1): the assistant offers to remember ("Shall I remember
  that the bike charges in the garage?"), a person sees and forgets it;
  never written from text a person did not say.
- **Speaking first** is automations' job: the bike done charging is a
  notification an automation sends; the assistant may word it (`ask:`).
  Digests, quiet hours, a reason on every message, *stop telling me this*.

### 4.16 The builder: kraftverk extending itself

Long term, and in stages, each useful on its own:

1. **It knows its own code.** The assistant reads kraftverk's documents and
   code (the `kraftverk-code` skill, read-only) and answers "can you
   support these speakers?" with what it would take, as a written proposal.
2. **It builds, apart.** A **builder** — a container of its own beside the
   server, not the hub — runs a coding agent behind a `Builder` port
   (adapters: the Claude Agent SDK; opencode for any other model). Its own
   clone, a branch, no secrets, no Docker socket, no access to the
   database, the broker or the devices; outbound only to the model, the
   package registry and Forgejo; a token that pushes branches, never `main`.
3. **The checks are the gate.** The pipeline runs on its branch:
   typecheck, tests, the architecture, knip, end to end. The gate's own
   files, the gateway's whitelists and the device packages that guard
   hardware are **protected**: a branch that touches them is refused
   unless the owner says otherwise for that change.
4. **The owner says yes, in the app**: what it does in words, the diff,
   the checks, the new device simulated. A change to the database's schema
   — which resets it — is said as such, and is the owner's alone.
5. **It deploys, and comes back.** Merged to `main`, the pipeline deploys
   as today, with a health check that rolls back to the previous image by
   itself. The conversation is kept (§4.1), the app reconnects, and the
   assistant goes on: *"Deployed. Your speakers are under Add device."*
6. **Later, without a deploy**: packages from outside the repository
   (PLAN-INTEGRATIONS §11), so a new integration need not rebuild kraftverk.

### 4.17 Evaluation, from the first slice

`packages/assistant/eval`: scenarios on a **simulated home** (simulated
devices, the fast clock), each a request and the state it should end in:

- **ask** (questions answered against the true state), **act** (single
  commands, English and Swedish, written and as speech transcribes them),
  **author** (automations and scripts that check and rehearse right),
  **errands** (on the fast clock), **safety** (injection through a device's
  name, a refusal kept, a never not tried).
- Graded by code on the final state; reported as pass^k, latency, tokens,
  cost — per model, per way (tools or code mode), per runtime and
  quantisation for local models; homes of 25, 100 and 300 devices.
- **What makes a model recommended for a role** — the lower bound over
  three runs must clear it:

  | Role | Threshold (to be tuned on the first results) |
  | --- | --- |
  | Commands (`voice`) | The right end state ≥ 95 % on a small home, ≥ 90 % on a medium one; calls to tools that do not exist ≤ 0.5 %; a warm answer in 1.5 s at the 95th percentile on that hardware |
  | `ask:` | Well-formed 100 %; right ≥ 95 % on its classification set |
  | Conversation | Right about the home's state ≥ 90 %; Swedish checked |
  | Writing | Checks first time ≥ 90 % under a grammar; behaves on the simulated traces ≥ 80 % |
  | Errands | ≥ 80 % done; within budget; no tool that does not exist |
- In CI: the harness against a scripted model, so it is always green and
  fast; real models on the owner's server on demand, with a report kept.

## 5. Why this, and not something else

- **Not everything MCP**: MCP is a door for outside agents; inside,
  kraftverk's own tools give its gate, its asks, its streaming and voice,
  with no protocol between.
- **Not an SDK's agent loop**: the loop is a few hundred lines, and the
  hard parts — the gate, asks, errands, the app's facts — are kraftverk's.
- **Not a model that runs forever for an errand**: automations hold what
  waits; a model is woken to think. Cheaper, explainable, and still working
  when the model is not.
- **Not tools for everything nor code for everything**: few tools for
  small models and voice, code for strong models, the evals deciding.
- **Not a coding agent in the hub**: one that edits code must not be able
  to touch what runs.

## 6. Risks

| Risk | What answers it |
| --- | --- |
| A local model switches the wrong device | Names resolved by `look`, never fuzzy in an `act`; matching first; the gateway's checks; the evals per model before it is offered for `voice` |
| Injection through a device's name or a message | Untrusted text quoted and read without acting tools (§4.5); `ask:` has no tools; consequential acts ask a person |
| Cost runs away | Budgets per role, errand and automation; the prompt cache; `ai_usage` shown |
| Latency on a NUC without a GPU | Speech on the phone; matching first; a small model for commands with a stable cached prefix; a cloud model for a role only by choice |
| A local model is too weak for a role | Recommended only by the evals; the family told plainly which roles its hardware carries; a grammar and the checker's repair loop for writing |
| "Local" that is not | Where a connection runs is checked at each call; only kraftverk's shut-in `models` service is *sealed* |
| A person's location sent to a cloud | §4.14: presence at each person's sharing, never positions; local only on request |
| The builder harms what runs | Its own container and branch; protected paths; the checks; the owner's yes; health check and rollback; no schema change without the owner |
| Provider APIs keep changing | The adapters, one per wire protocol, are the only place that knows them |
| Swedish on the phone recogniser is weak | KB-Whisper on the server behind the same port |

## 7. The order of work

Each slice green and pushed, the evals growing with it.

| Slice | What | Done when |
| --- | --- | --- |
| **AI0** | The eval harness on a simulated home with a scripted model (§4.17); the caller with a person id and `via`; agent tokens | An outside agent signs in with a token and the timeline names it |
| **AI1** | The operations described once (§4.2): the gate table, the server's parsing, MCP's tools and `API.md` generated | No hand-written schema left; the compiler refuses a missing piece |
| **AI2** | The world for a model (§4.3) and the skills (§4.4) | "Where is Anna?" and "what's in the kitchen?" answered over MCP |
| **AI3** | `packages/llm`: the Chat adapter first, then Messages and Responses; presets for the local servers and OpenRouter; connections, roles, where each runs, and usage in Settings | A conversation through each adapter in the evals; a local server added by its address and shown *on your network* |
| **AI3L** | Local, first-class: the `models` service (llama.cpp and Speaches, shut in), downloads with hashes, Ollama managed, the catalogue, the hardware read, the self-test; the first recommended models by role from the evals | A server with no GPU and one with a GPU each get a proposal, download it, pass the self-test, and answer in Swedish with nothing leaving the house |
| **AI4** | `packages/assistant`, the tools, asks and the policy (§4.5–4.8); the conversation in the app, written | "Turn on the plug in this room" from a room's screen; a consequential act asked and said yes to from a notification |
| **AI5** | Authoring by conversation: automations and scripts, the server's type check, code mode measured | An automation drafted, rehearsed and saved watching from one request |
| **AI6** | Voice: the ports, the phone's speech both ways, push to talk; KB-Whisper on the server | Asked by voice in Swedish and English, answered aloud, first audio in about 2 s |
| **AI7** | Errands (§4.9) | The bike charged by morning, on the fast clock in the evals, and on the owner's bike |
| **AI8** | `ask:` and `errand:` in the language (§4.10) | Both in the registry, the editor, YAML and the reference |
| **AI9** | Memory, privacy settings, digests | A person reads and forgets what it remembers |
| **AI10** | The builder, stages 1–5 (§4.16) | A device package proposed, built on a branch, approved in the app, deployed and rolled back on a failed health check |
| **AI11** | Realtime voice, a wake word, a speaker in a room | — |

## 8. Decisions for the owner

1. **The model port**: kraftverk's own, one adapter per wire protocol on
   `fetch`, with OpenRouter and every local server as presets
   (recommended); or the AI SDK's provider packages as the adapters, under
   kraftverk's own loop?
2. **Describing the API**: zod 4 schemas in `api-contract`, one declaration
   per operation, generating the rest (recommended)?
3. **Local first**: kraftverk ships the optional `models` service, reads
   the hardware and proposes local models per role, recommended only by
   the evals; every role local by default, a cloud model only for a role
   the family names (recommended)? And on a server too small for a role —
   a Pi, an N100 for writing — say so, and offer the cloud for that role
   only?
4. **What an agent may do unasked**: reads and non-consequential acts
   (recommended), with the home's policy to narrow or widen per capability?
5. **Errands**: a grant listed and said yes to once (recommended); at most a
   week; a budget by default?
6. **The language**: `ask:` with no tools and `errand:` within the
   automation's own power (recommended)?
7. **Voice**: the phone's own speech first and KB-Whisper on the server for
   Swedish (recommended), or the server first; realtime speech later as a
   choice? Dictation keyboards such as Wispr Flow supported by a text box
   that works with them, and an adapter only if its API opens
   (recommended)?
8. **The assistant's voice**: one persona with a voice per engine — Piper
   by default, Chatterbox with a GPU, a cloud voice by choice
   (recommended)? Its name, and whether a family member's own voice may
   ever be one (recommended: only theirs, by their consent, never a
   child's)?
9. **What a cloud model may see**: devices, readings and history; presence
   at each person's sharing; never positions; names replaced by stand-ins
   (recommended)?
10. **Memory**: each person's own, visible and forgettable, written only
    from what they said (recommended)?
11. **The builder**: its own container, a branch, the checks, the owner's
    yes, rollback; the Claude Agent SDK first and opencode for other models
    (recommended)? Which paths are protected?
12. **Where the assistant runs**: on the server's hub, and in the app with
    no server (recommended), or the server only?
13. **Its name and the words**: "the assistant", and "errand" for a goal
    with an end?
