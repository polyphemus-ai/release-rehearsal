# Model routing and fallbacks

**Goal:** you set a bot's models in one line. What actually happens is predictable, and
Polyphemus can always explain why a given model answered.

## Configuring it

A route is an ordered list: the first entry is the primary, and the rest are fallbacks in
order.

```toml
[bots.coder]
route = ["claude", "gpt", "grok"]

[routes]                                  # named, reusable
smart = ["claude", "gpt", "grok"]
cheap = ["anthropic:claude-haiku-4-5", "xai:grok-4.1-fast"]

[bots.researcher]
route = "cheap"

[bots.reviewer]
route = ["grok", "claude"]                # a different provider from the coder, on purpose
```

The same syntax works everywhere: `polyphemus -m "claude > gpt > grok"`, `/model claude > gpt`.
In the app, a route is a drag-to-reorder list on the bot.

## What "deterministic" means here

Given the same route and the same provider state, Polyphemus makes the same choice, and it
records why.

### 1. Every error is classified first

Each adapter maps provider errors to one class. OpenClaw missed xAI's `encrypted_content`
errors because its failover matched error strings, not classes.

| Class | Examples |
|---|---|
| `rate_limited` | 429 with `retry-after` |
| `quota_exhausted` | spend cap (Anthropic `enforced_spend_limit_reached`, OpenAI `insufficient_quota`), a 5-hour or 7-day subscription window at 100% |
| `overloaded` | 529, 500/502/503, timeouts, connection failures |
| `context_exceeded` | the prompt is longer than the model's window |
| `refusal` | `stop_reason: refusal` |
| `replay_rejected` | the provider rejects its own replayed reasoning. **Already handled in phase 1:** retry once without it |
| `auth` | 401, 403 |
| `invalid_request` | 400, 404 |

### 2. What each class does

| Class | Retry the same model? | Fall back to the next model? | Circuit breaker |
|---|---|---|---|
| `rate_limited` | Yes, honouring `retry-after`, 1–2 times | Yes, if the wait is longer than the task can afford | Open until the reset time |
| `quota_exhausted` | No | Yes | Open until `resets_at` (or until the balance changes) |
| `overloaded` | Yes, with backoff and jitter (2 tries) | Yes, once retries are used up | Counts toward the failure rate; half-open probe after a cool-down |
| `context_exceeded` | No | Only to a model with a **larger** window; in workflows, prefer a fresh-context handoff | No |
| `refusal` | No | Claude handles this server-side (`fallbacks: "default"`); polyphemus-level fallback is opt-in (`fallback_on_refusal`) | No |
| `auth` | No | **No: stop and alert.** A broken key is a config bug | Marked broken until fixed |
| `invalid_request` | No | **No: stop.** It would fail on the next model too, or hide a bug | No |

Polyphemus goes further than the single-vendor tools here. Claude Code's `fallbackModel` never
switches on rate limits or billing, because it has nowhere else to go. Polyphemus does, so
`rate_limited` and `quota_exhausted` fall back.

### 3. Circuit breakers

- **Per (provider, account, model).**
- **Quota breakers are time-based:** they stay open until the reported reset time, with no
  probing.
- **Error-rate breakers** trip at 3 failures per minute or a failure rate above 50%. They
  cool down, then half-open with a single probe (LiteLLM and Portkey defaults).
- The capacity monitor can open a breaker *before* a failure, when its forecast says the
  quota will run out mid-task ([capacity.md](capacity.md)).

### 4. Stickiness

A session **stays on the model it's using**. Switching models costs a full prompt-cache
rewrite and loses reasoning continuity (OpenRouter and Anthropic both pin for this reason).

- After a fallback, the session stays on the fallback model.
- **Switching back to the primary happens only at a boundary:** a new workflow node, a new
  task, or a new session. Never mid-conversation.
- In an interactive session, the UI offers a chip instead: "claude is available again, switch
  back?"

### 5. Fallback policy depends on what the bot can do

A fallback swaps the worker. For a chat that's a convenience, but for a bot that can write
code, push, or spend, it's a change in who is doing the job. OpenClaw's #808 showed the cost:
Grok ran out, the builder agent silently moved to a fallback nobody had chosen for that role, and on that
model it forged an allocation.

```toml
[bots.forge]
route = ["grok", "claude"]        # only these, in this order; there's no hidden global chain
on_fallback = "ask"               # ask | continue | pause
```

| `on_fallback` | Behaviour | Default for |
|---|---|---|
| `continue` | Switch and keep going; the switch shows in the session | Interactive sessions and read-only bots |
| `ask` | Stop at the next node boundary and ask on your phone: *"Grok is out until Mon 8:23 PM. Continue #808 on claude (opus)? [Yes] [Pause] [Pick another]"* | **Bots that can act** (write, push, spend) |
| `pause` | Stop and wait for the primary to come back (for example, schedule "resume at reset") | Roles you only trust on one model |

More rules:

- **Checked before starting, not discovered mid-run.** The capacity monitor already knew Grok
  was empty (Polyphemus classified the 402 as `quota_exhausted`). A run never *starts* a node on a
  provider known to be out. It applies `on_fallback` up front.
- **Never outside the route.** A bot only ever runs on models listed in its route.
- **The model a node ran on is part of its record** (`attempts`). An unexpected model shows up
  as an event, never as silence.
- **Switching is one command:** `polyphemus bot route forge "claude > grok"`, or one tap in the
  app. In OpenClaw, "switch it to claude opus" took a chat exchange with an agent. Here you just
  do it.

### 6. Every attempt is recorded

Each assistant message already records the model that produced it (`origin`). Routing adds
an `attempts` record, like Vercel AI Gateway's `modelAttempts`:

```json
[{ "model": "anthropic:claude-opus-5", "class": "quota_exhausted", "resets_at": "14:05" },
 { "model": "openai:gpt-6-astra", "ok": true }]
```

The UI renders this as "claude's weekly limit is used up until 14:05, so gpt answered."

## Why switching models is safe

History is stored in a provider-neutral form, and each message keeps its native form for
exact replay to the model that wrote it. A fallback model gets canonical text and tool calls;
thinking stays with its own model; tool-call ids carry across. Built and tested in phase 1.

## Also carried on a bot

```toml
[bots.coder]
route = ["claude", "gpt"]
effort = "xhigh"                  # passed to whichever model runs, if supported
budget = { daily_usd = 20 }       # see capacity.md
```

## Built so far (2026-09-10)

- **Error classes:** every adapter classifies its errors (`classifyError`, `ProviderError`). Only
  `rate_limited`, `quota_exhausted`, and `overloaded` trigger a fallback.
- **Config:**
  - `[routing] fallback = [...]` plus `on_fallback = "ask" | "continue" | "pause"`
  - a per-model `fallback` list that overrides the global one
  - with no list, Polyphemus *offers* every other ready model but never switches to one on its own
  - **and "every other ready model" means every provider you can use, not only the named ones**
    (2026-09-11). A provider you're signed in to but haven't given an alias was invisible to
    fallback, which is the wrong way round: not having named it is a gap in your config, not a
    reason to be stranded when the model you were using runs out. A vendor CLI is offered as its
    own `default`; an API provider is offered **the last model id actually used on it**, because
    a guessed one fails at exactly the moment you need it not to, and is skipped entirely when
    nothing has run on it yet
- **Checked before sending:** a turn never starts on a provider known to be out, whether from a
  stored `quota` marker or a window at 100%.
- **A quota marker ends** (2026-09-16, `core/src/quota.ts`): at the reset time the error gave (from
  the provider, or "try again in 2 hours" in its message), and when it gave none, an hour after the
  error. A three-day-old "usage balance exhausted" had kept grok-build out while its plan was at 2%.
  After that hour the next real turn meant for it is the test — nothing probes — and a turn that
  works clears the marker. The notice and the status line say when it happened and when it's tried
  again.
- **Retrying without repeating your message:** after a failure, the next model continues from
  history.
- **Interactive prompts:** `Switch to X and retry? [Y/n/p]`. A fallback switch lasts for the
  session only and doesn't change your default.
- **`-p` mode** switches automatically only with an explicit list and `on_fallback = "continue"`.

- **Circuit breakers** (built 2026-09-11, `core/src/breakers.ts`): 3 overloaded or unknown
  failures within a minute rest a provider for a minute; then one test turn goes through while
  others wait, and a failed test doubles the rest (up to 10 minutes). A rate limit rests it for a
  minute at once; a rejected login rests it for 10. Choosing the model yourself clears it.
  Sessions, fallback candidates, routines, and the model list all ask one question,
  `polyphemus.unavailable(provider)`: out of usage, or resting.

Not built yet: breakers per account and model (they're per provider), the capacity forecast
opening one early, the `attempts` record on each message, route syntax (`a > b > c`), and
per-bot policy (that arrives with bots).

## Provider, model, and how you get in

Decided 2026-09-12, after the owner kept being confused by the same screen three times: *"our default
is called claude, the subtitle says claude-code:default, that doesn't even make sense to me... I
didn't realize claude-code was a provider."*

That was right, and the cause is that `config.providers` is keyed by **connection** — a
(company × how you get in) pair — while the word it uses is "provider". So `claude-code` and
`anthropic` are one company reached two ways, and any screen printing the key reads as though
Claude Code were a vendor and `default` were a model.

**Three properties, always, in this order:**

| | Example | Where it comes from |
|---|---|---|
| **Provider** — the company | Anthropic | the connection's vendor |
| **Model** | `claude-opus-5`, or "whichever it picks" | `models.<alias>.model` |
| **How you get in** | Claude Code CLI, API key | the connection's auth |

The config keeps its connection keys — renaming them would be churn for no gain — but **nothing
user-facing prints one**. `connectionOf()` in the daemon maps a key to those three facts, and both
the provider list and the model list are built from it.

**"Whichever it picks" is one option, not the only one** (corrected 2026-09-12). `model =
"default"` hands the choice to a vendor's CLI, so Polyphemus can't name the model up front — and it
says what answered last, because every reply records its origin, so a `default` model reads
"whichever it picks — last was claude-opus-5". But the CLIs all take a model id, and the screen
read as though they didn't: The owner, "with all the CLIs in OC, I'm able to select the model I
want." A named model can be pointed at any model its connection offers, `default` included, from
its own screen. What a connection offers comes from the connection: Claude Code and Grok report
their own lists, and Codex's came back as just `["default"]` until it started reading
`~/.codex/models_cache.json`, which is the account's real list and stays current on its own.

## Where model facts come from (decided 2026-09-12)

The owner, pointing at the three providers' model pages: "I don't know the best way to maintain this
once we go opensource."

Two different things live in that question, and they get opposite answers.

**Model ids and their limits are never stored.** They change constantly, and a stale context window
is worse than none — it fails a request Polyphemus said would fit. They come from the provider, every
time, and Polyphemus keeps whatever that provider volunteers:

| | List endpoint | What it says |
|---|---|---|
| Anthropic | `GET /v1/models` | display name, `max_input_tokens`, `max_tokens`, capabilities |
| OpenAI / OpenAI-compatible | `/v1/models` | little beyond the id |
| xAI | none documented | — (ids come from the `grok` CLI) |
| Claude Code | no list command | the names the CLI accepts |
| Codex | `~/.codex/models_cache.json` | slug and display name, kept current by codex itself |

So `listModels()` returns `ModelInfo` — `id`, and `name`, `contextWindow`, `maxOutput` *where the
provider said*. A provider that only gives ids shows only ids. Uneven, honest, and it improves on
its own as providers add fields, with no release from us.

**The provider catalogue is curated, and that's fine.** Which companies exist, base URLs, env var
names, docs links: about 28 entries that change every few months, and no API will tell us. Still to
do for open source: move it from a TypeScript array to a data file, so adding a provider is a
one-line PR rather than an edit-and-release, with a refresh path (`~/.polyphemus/catalogue.json`) so a
new provider doesn't wait for a Polyphemus version. Pricing stays out of it for the same reason as
usage cost ([capacity.md](capacity.md)): a wrong number is worse than none.

## Looking after your models (decided 2026-09-12)

From the owner's Models & providers mockup:

- **How a model is doing comes from what actually happened.** Every turn records its model's last
  success or failure per connection (`model_results`); a model is *working* once a real turn or a
  test succeeds, *not run yet* before that, and *needs attention* when its latest attempt failed —
  a `403 model_not_available` from a plan that doesn't include it, say, while the connection itself
  is fine.
- **Tests are real and say their price first** (capacity.md).
- **Moving a model to another way in rewrites it everywhere it's named**: your models, the default,
  the backup list, and any `agent.toml` that runs on it or falls back to it — one config revision,
  so one undo. Threads keep the connection they started on until you switch their model.
- **Removing a model takes it out of the backup list too**, refuses the default, and never signs
  anything out. There's no separate Disable: a chosen model has no settings to keep.
- **`routing.allow_metered` (default off): a fallback never moves you from a plan onto an API key
  billed per token without your say-so.** Skipped candidates are named in the thread. Already on an
  API key, moving to another isn't a new kind of cost, so it isn't blocked.

## Build order

| Phase | Work |
|---|---|
| 2 | Remaining: breakers, stickiness boundaries, the `attempts` record, route syntax in the CLI |
| 5 | Route editor and "why this model" in the app |
| 6 | Per-bot and named routes, budgets |

## Key sources

[Claude Code model config](https://code.claude.com/docs/en/model-config),
[Anthropic refusals and fallback](https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback),
[LiteLLM reliability](https://docs.litellm.ai/docs/proxy/reliability),
[OpenRouter fallbacks](https://openrouter.ai/docs/guides/routing/model-fallbacks),
[OpenRouter cache stickiness](https://openrouter.ai/docs/guides/best-practices/prompt-caching),
[Portkey circuit breaker](https://portkey.ai/docs/product/ai-gateway/circuit-breaker),
[Vercel AI Gateway fallbacks](https://vercel.com/docs/ai-gateway/models-and-providers/model-fallbacks).
