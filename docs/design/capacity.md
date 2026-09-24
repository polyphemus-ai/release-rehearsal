# Capacity and usage

**Goal:** you and your bots always know how much room is left on every provider and when it
resets, and act *before* a limit stops work. Examples: your Codex weekly window is at 97%
right now (from its session logs), and the weekly window hides behind a healthy-looking
5-hour one.

## Signals we can actually get

| Source | Signal | How we get it |
|---|---|---|
| Anthropic API | `anthropic-ratelimit-{requests,tokens,input-tokens,output-tokens}-{limit,remaining,reset}` headers; `retry-after`; `enforced_spend_limit_reached` (means stop until the 1st, not back off) | Passively, from every response |
| OpenAI API | `x-ratelimit-{limit,remaining,reset}-{requests,tokens}` headers (resets are durations like `6m0s`); `insufficient_quota` | Passively |
| xAI API | `usage.cost_in_usd_ticks` (the real billed cost per request). Rate-limit headers are unverified | Passively. Prepaid balance and spending limits come from the management API (needs a management key) |
| Claude Code (Pro/Max) | `rate_limits.five_hour` / `seven_day` `{used_percentage, resets_at}` | A tiny statusline command that writes the data to a state file; `rate_limit_event` from stream-json |
| Codex (ChatGPT plans) | `token_count.rate_limits.{primary,secondary}.{used_percent, window_minutes, resets_at}`, credits | Follow `~/.codex/sessions/**/rollout-*.jsonl`, or subscribe to `account/rateLimits/updated` through `codex app-server` |
| OpenRouter | `/api/v1/key` returns `limit_remaining`, `usage_daily/weekly/monthly` | Poll every 1–5 minutes |
| Admin usage and cost APIs (Anthropic, OpenAI) | Daily cost, usage by model | Hourly poll. Needs admin keys, and Anthropic's doesn't work on individual accounts |
| Grok CLI (SuperGrok) | `config.creditUsagePercent` and `currentPeriod {type, end}` from `cli-chat-proxy.grok.com/v1/billing?format=credits` (not a documented API) | With the Grok CLI's current sign-in, every 5 minutes (`agents/grok-usage.ts`, 2026-09-16). An expired sign-in or a failed lookup is "unknown", never guessed; a reading with room ends an earlier quota error |

## Data model

One record per window, with append-only samples:

```ts
interface CapacityWindow {
  provider: string; account: string;
  window: '5h' | '7d' | 'rpm' | 'tpm' | 'monthly' | 'credit';
  usedPct?: number; used?: number; limit?: number;   // whichever the source gives
  resetsAt?: Date;
  source: 'headers' | 'statusline' | 'codex-rollout' | 'poll' | 'estimate';
  observedAt: Date;
  confidence: 'exact' | 'rounded' | 'estimated' | 'unknown';
}
```

Our own per-request usage (tokens, cache hits, cost) is logged per session, bot, and run, so
we can answer "what did this ticket cost?"

## Forecasting and thresholds

- **Pace** = `usedPct` ÷ fraction of the window elapsed. At 1.0x you finish exactly at reset.
- **Projected exhaustion** = now + remaining ÷ burn rate, where burn rate is an exponentially
  weighted average over the last 30–60 minutes.
- **Alerts fire on the forecast, not the level.** "Runs out before it resets" is what
  matters.

| Level | Action |
|---|---|
| 50% | Information only |
| 75%, or forecast to run out before reset | Warn you and the bots that use this provider |
| 90% | New work routes to the next model in the route |
| 100% | Breaker opens until reset ([routing.md](routing.md)) |

Each window gets its own line. A calm 5-hour window never hides a nearly used-up week.

## Letting bots know

Two channels:

- **A capacity line in each turn**, appended at the end, not in the cached prefix:
  `claude 5h 62% (resets 14:10, pace 1.3x) · 7d 41% · next: gpt`
- **A `capacity()` tool** for details, which bots call before committing to large work.

What bots are expected to do with it (in the system prompt and in workflow rules):

1. **Size the work.** Anthropic task budgets (`task-budgets-2026-03-13`) give Claude a
   countdown so it finishes gracefully.
2. **Checkpoint before running out.** Write the handoff and commit, so another model can
   resume.
3. **Switch at a task boundary** when the forecast says the current model won't last.
4. **Defer non-urgent work** until after the reset. Workflows can schedule "resume at reset".
5. **Limit fan-out.** Parallel runs are capped per provider. Both Anthropic and OpenAI have
   had to reset limits after runaway subagents drained quota.

## What you see

- **Meters:** one bar per window, with a reset countdown, as in Claude's usage page and
  CodexBar's menu-bar meters. They sit on the desktop tray, a phone widget, and a
  Live Activity while work runs.
- **"Why this model":** the `attempts` record on each message.
- **Spend:** today, this week, per bot, per run, with sparklines.
- **Alerts** only on forecast breaches and on reset ("Codex weekly window reset 🎉").

## Usage should follow use, not declaration (open, 2026-09-12)

The owner, on a freshly wiped install: "showing statistics for usage without even having providers and
models configured is wild." That was right, and the rows were real — the five-minute poll asks every
CLI provider *declared in config*, and `DEFAULT_CONFIG` declares six, so within seconds of a first
start Polyphemus is charting windows for providers nobody has touched.

Polling what's declared is the wrong trigger. The meters plausibly belong behind "at least one
model is chosen", and scoped to providers a chosen model actually routes to. Left open with
[roadmap.md](roadmap.md) item 1a, which is the same question from the other end: what a fresh
install is allowed to already have.

## Freshness, and what can be polled

Decided 2026-09-12, after the owner asked why codex's numbers were wrong: its reading was 37.6 hours
old, and Polyphemus both displayed and forecast from it as though it were current.

**A reading is only as fresh as the last turn on that provider.** That's not a bug in itself —
it's how the sources work — but treating a frozen number as live is. Two rules now:

- **A stale reading never forecasts.** With no recent samples the pace is unknown; the old code
  fell back to averaging across the whole window, which turned a day-old 98% into "at this pace
  it runs out in two hours", repeated on every daemon restart. A forecast carries `observedAt`
  and `stale`, and a stale one reads "98% as of Thu 8:25 PM — nothing has run on it since". Its
  meter is dimmed, and it never raises a notification.
- **Poll only what's free.** Spending quota to find out about quota is a bad trade, so what can
  be polled is decided per source:

| Source | Poll? | Why |
|---|---|---|
| **Codex** | ✅ every 5 minutes, but only past turns | Its rollout logs are the only free source, and a log records activity — never a *reset*. Checked 2026-09-12: `codex` has no usage subcommand, `codex doctor` reports none, its `state`/`logs` databases cache none, and `/usage` is a TUI command that `codex exec` passes to the model as a message (it cost 9,491 tokens to find that out). So a codex reading can go out of date and nothing local can tell |
| **Claude Code** | ✅ every 5 minutes | The owner: "claude literally has a `/usage` command.. weird". It does, and it's reachable non-interactively: `claude -p /usage --output-format json` returns `num_turns: 0`, `total_cost_usd: 0` and no tokens, so it costs nothing. It reports more than the stream ever did, including a separate weekly cap for Fable. Asking leaves a transcript behind, so Polyphemus deletes the one it caused, by the id it was handed |
| **API providers** (Anthropic, OpenAI, xAI, …) | No | Limits arrive only in response headers, so a poll means a real request against the thing being measured |

For anything that can't be refreshed — the API providers, and codex between turns — honesty is
the whole answer, and "say how old it is" turned out not to be enough on its own. The owner's codex
weekly limit reset while Polyphemus still showed 98% used from a day-old reading, with a nearly full
bar. **A stale reading is drawn as a last-known value, not a level:** the track is empty and
hatched, and the number reads "last seen 98%". A bar is a claim about right now, so it shouldn't
be drawn from something that isn't.

And a reading older than its own window is dropped outright: a `7d` reading observed more than
seven days ago cannot describe the current window, whatever reset time it carried.

**Startup doesn't ask.** Opening a `Polyphemus` reads files only; running someone else's CLI is the
daemon timer's job. Otherwise every test that constructs one would shell out to a real `claude`,
which is how this was first written and how it was caught. An admin/management API would change this for some providers — that's the
"management API pollers" line in the build order, and it needs credentials Polyphemus doesn't ask for
yet.

## No synthetic prompts to read usage (decided 2026-09-12)

The owner asked the obvious question: if usage arrives with a request, should Polyphemus send a small
periodic prompt just to collect it? Measured, on the owner's machine:

| Probe | Cost |
|---|---|
| `codex exec` (one turn) | **17,583** and **38,163** tokens, two runs |
| `claude -p /usage` | 0 tokens — it's a local command, not a turn |
| A 1-token API request | ~20 tokens in, 1 out |

**On a vendor CLI there is no such thing as a small prompt.** The floor isn't your message, it's
the CLI's own system prompt, skills and `AGENTS.md` — most of it cached, all of it counted. At
five-minute polling that's over 5M tokens a day to find out how many tokens are left, and the
probes would land in the statistics being read: Claude Code's `/usage` reports request and session
counts, so Polyphemus would be measuring itself.

For API-key providers a probe really is cheap, and it was still declined: nothing should spend
against an account in the background that the user didn't ask for, and a probe inflates the
request totals the provider shows them. **Polyphemus harvests, it doesn't probe:**

- free local sources, polled (Claude Code's `/usage`, codex's rollout logs)
- headers and logs from real turns, which arrive with work already being done
- and where neither is available, it says how old the number is rather than refreshing it

An admin/management API would give live numbers for the API providers without a probe at all;
that's the honest way to close the gap, and it needs a credential Polyphemus doesn't ask for yet.

**A test you press is not a probe (decided 2026-09-12, later).** The Models & providers screen has
Test buttons, and the owner chose real requests over free checks. That's consistent with the rule above,
which is about spending *in the background*: a test only ever runs because someone asked, and the
button says what it costs before it runs — about 20–40k tokens of a plan through a CLI (the floor
measured above), a few dozen billed tokens on an API key. Its result is recorded the same way a
real turn's is (`model_results`), so the screen can say "worked 2 hours ago" without asking again.

## Build order

| Phase | Work |
|---|---|
| 2 | Passive header capture in both adapters, the Codex rollout reader, Claude Code statusline collector, usage log, `poly usage` meters in the terminal, capacity line and tool |
| 2 | ✅ Forecasts (`core/src/forecast.ts`): readings are kept 8 days (`capacity_samples`); pace, and the run-out time from the last hour's burn rate (else the pace so far this window). Shown in `poly usage`, the app's meters and Team tab, and every message's status line (with an instruction to save progress when it won't last); a notice once per session and a phone alert once per window when a provider starts heading for an early run-out. Still to come: the 90% threshold routing new work to the next model, and the forecast opening a breaker early |
| 5 | Tray, widget, and Live Activity meters; spend views |
| 5 | **Usage and cost per provider** (noted 2026-09-12, from OpenClaw's model-provider settings): each provider's card showing its own windows, its balance where the provider reports one, and spend over 30 days with a token and session count — OpenClaw shows "Global session spend · 30d · $623.18 · 928.2M tokens · 23852 sessions" per provider. Polyphemus tracks usage *windows* today but not money: it needs a price table per model, per-turn token counts (already in the session store) rolled up by provider, and an honest "no live usage data reported by this provider" where a provider says nothing. Deliberately not guessed at in the meantime |
| later | Management/admin API pollers (xAI balance, OpenRouter, admin keys) |

## Key sources

[Anthropic rate limits](https://platform.claude.com/docs/en/api/rate-limits),
[OpenAI rate limits](https://developers.openai.com/api/docs/guides/rate-limits),
[xAI cost tracking](https://docs.x.ai/developers/cost-tracking),
[xAI management API](https://docs.x.ai/developers/rest-api-reference/management/billing),
[Claude Code statusline](https://code.claude.com/docs/en/statusline),
[Anthropic task budgets](https://platform.claude.com/docs/en/build-with-claude/task-budgets),
[CodexBar](https://github.com/steipete/CodexBar/),
[Claude-Code-Usage-Monitor](https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor),
[OpenRouter limits](https://openrouter.ai/docs/api-reference/limits).
