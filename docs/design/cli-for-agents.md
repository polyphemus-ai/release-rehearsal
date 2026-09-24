# A CLI that agents can't get wrong

**Goal:** any agent (Claude Code, Codex, Grok, a browser agent, or one of our own bots) can
discover exactly what Polyphemus can do and use it correctly on the first try. When it does get
something wrong, Polyphemus refuses clearly and explains the fix, instead of breaking your setup.

## Why this is a pillar

Agents in an earlier OpenClaw setup repeatedly gave wrong commands and broke it. Its config directory held about
18 `.bak`/`.clobbered`/`.pre-*` copies of `openclaw.json`. The uncomfortable part: **OpenClaw
already had validated `config set/patch/validate` commands and a backup ring, and agents
hand-edited the file anyway.** So:

1. The safe path has to be the one agents **discover first**.
2. **Edits made outside the CLI are detected**, and nothing runs on a config that hasn't been
   validated.

## Where practice has landed (2025–2026)

- **Agents learn CLIs from `--help`,** and a good CLI costs fewer tokens than MCP. Claude Code's
  docs call CLIs "the most context-efficient way" to reach services, and Playwright shipped a
  CLI next to its MCP server for this reason. Mario Zechner found the two roughly equal: "the
  protocol is just plumbing". Build the CLI well, then wrap it in MCP.
- **The CLI should document itself** at runtime (`gh --json` lists its fields; `kubectl explain`).
  Justin Poehnelt: "Agents hallucinate. Build like it."
- **Standard guidance files:** `AGENTS.md` (Linux Foundation; read by Codex, Copilot, Cursor,
  Jules), `SKILL.md` Agent Skills (Claude Code, Codex, Gemini CLI, Cursor), and `llms.txt` for
  docs.
- **Plan, then apply exactly the plan:** Terraform `plan -out` / `apply <plan>`, kubectl
  `--dry-run` and `rollout undo`.
- **Non-interactive by default for agents:** never prompt without a TTY (clig.dev). Vercel
  switches to non-interactive when it detects an agent.
- **Errors that tell the caller how to fix the call** (Anthropic's *Writing tools for agents*).

## Design

### 1. One command registry, everything generated from it

Each command is declared once in TypeScript:

```ts
{ id: 'config.set', summary, args: z.object({...}), output: z.object({...}),
  effects: 'write',            // read | write | destructive
  idempotent: true, scopes: ['config:write'], examples: [...], since: '0.3' }
```

The usage text, `poly help`, `help --json`, `poly capabilities` and the MCP tools are all generated
from the registry, so **they can't drift apart**. (A generated `docs/cli.md` and agent skill file,
checked by CI, are the goal; they don't exist yet.)

### 2. Discovery

| Command | Returns |
|---|---|
| `poly capabilities --json` | Version, schema version, commands (names and summaries only, to save tokens), providers, your caller scope, and config paths. **The first thing an agent should run** |
| `poly help <cmd> --json` | Arguments, flags, output schema, effects, and examples for one command |
| `polyphemus schema <cmd \| config>` | Full JSON Schema, like `kubectl explain` |
| `polyphemus agent-guide` | A short `AGENTS.md` section: the rules and the three commands to start with |
| `poly skills install` | Writes `SKILL.md` files so Claude Code, Codex, and others discover Polyphemus on their own |

### 3. Output

- **`--json` works on every command,** with one envelope:
  `{ ok, schemaVersion, data, warnings[], error? }`. It turns on automatically when stdout
  isn't a terminal, or with `POLYPHEMUS_OUTPUT=json`.
- **Long-running commands use `--jsonl`** (one event per line, ending with a `result` line).
- **`--fields a,b`** trims the output to what the caller needs.
- **Deterministic output:** sorted keys, ISO times, no colour or spinners when piped. The reply
  goes to stdout and everything else to stderr.

### 4. Changes are planned, validated, and reversible

- **Every write supports `--dry-run`,** which returns `{ diff, planId }`. `--plan <id>` applies
  exactly that plan, and refuses if anything changed since it was made.
- **Destructive commands need `--confirm <name>`** or the dry-run's token. Writes accept
  `--idempotency-key`.
- **Config commands:** `config get | set | unset | patch | validate | schema | diff`, plus
  `config history`, `config undo`, and `config rollback --to <rev>`.
  - Every write validates the *whole* config, writes atomically, and records a numbered revision
    (who, when, which command, which caller). This replaces scattered `.bak` files.
  - **Drift detection:** the config's hash is recorded. If the file changes outside the CLI, the
    next command stops with `CONFIG_EDITED_OUTSIDE_CLI` and says to run `poly config adopt`,
    which validates the hand edit and records it as a revision, or `poly config undo`.

### 5. Errors and exit codes

Errors go to stderr, and inside the JSON envelope:

```json
{ "code": "UNKNOWN_FLAG", "message": "Unknown flag --modle", "param": "--modle",
  "suggestion": "--model", "fix": "polyphemus -m <model>", "docs": "poly help --json",
  "retryable": false }
```

| Exit | Meaning |
|---|---|
| 0 | ok |
| 1 | runtime failure |
| 2 | usage or validation error |
| 3 | not found |
| 4 | input or confirmation required (never a hanging prompt) |
| 5 | permission or scope denied |
| 6 | conflict or stale plan |
| 7 | transient, safe to retry |
| 10 | dry run found changes |

Error codes are a stable, documented list. Unknown flags and config keys are never silently
ignored.

### 6. Scopes for agent callers

- **Callers identify themselves.** An agent sets `POLYPHEMUS_CALLER=agent:<name>`, or Polyphemus
  detects a non-TTY caller.
- **Default scope is read-only for agents.** Humans grant more with profiles like `config:write`
  or `run`.
- **The default agent is Polyphemus's own (decided 2026-09-18).** It's told how Polyphemus works under
  the hood and may change it for the owner through the CLI — agents (`agents new`/`agents edit`),
  skills, projects, routines, models and settings — never by editing Polyphemus's files. Secrets,
  people and devices, the service, and anything destructive stay with the owner. The guide is
  given at run time (`polyphemus-guide.ts`), so it matches the installed polyphemus. Scopes that would
  hold every other agent to reads aren't built yet.
- **Some commands are human-only by default:** destructive ones and secrets administration.
- **Every call is audited** with the caller.

### 7. The MCP mirror

`poly mcp serve [--read-only] [--toolsets config,sessions,run]`:

- Tools are generated from the same registry, in a stable order (good for prompt caching).
- Each tool's `effects` become MCP annotations, and each tool returns `structuredContent` plus
  `isError` on fixable errors.
- The tool list is filtered by the caller's scope, and every write tool takes a `dry_run`
  parameter.

This is also how agent CLIs running *inside* Polyphemus (Claude Code, Codex, Grok) reach Polyphemus
features: memory, capacity, approvals, and routines.

## Anti-patterns we won't ship

- A hand-editable config with no drift detection
- Help text written separately for the CLI and MCP
- JSON output on only some commands
- Prompts that hang without a TTY
- Exit code 0 on partial failure
- Prose-only errors
- Colour codes in piped output
- `--force` that skips validation
- Treating MCP annotations as security (they're hints; scopes are the enforcement)

## Build order

| Phase | Work |
|---|---|
| 2 | ✅ Command registry (`packages/cli/src/commands.ts`); ✅ `--json` envelope, error codes, and exit codes; ✅ `capabilities`, `help --json`, `sessions show`; ✅ config commands (`get`, `set`/`unset` with `--dry-run` and exit 10, `validate`, `diff`, `history`, `undo`, `rollback`, `adopt`): edits touch only their lines, are validated whole, written atomically, and recorded in `config_revisions`; outside edits are pointed out on every command and block changes until adopted or undone; ✅ `mcp serve`: read-only commands as MCP tools, schemas from the registry's `params`. Still to come: `schema`, `agent-guide`, write tools over MCP (phase 3, with caller scopes) |
| 3 | Caller scopes and audit; write tools over MCP with dry-run and plans; `skills install` |
| 5 | Published docs site with `llms.txt` and per-command pages generated from the registry |

## Key sources

[clig.dev](https://clig.dev/) ·
[Anthropic: writing tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents) ·
[Anthropic: code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp) ·
[Claude Code best practices](https://code.claude.com/docs/en/best-practices) ·
[Armin Ronacher on tools](https://lucumr.pocoo.org/2025/7/3/tools/) ·
[Mario Zechner: MCP vs CLI](https://mariozechner.at/posts/2025-08-15-mcp-vs-cli/) ·
[Justin Poehnelt: rewrite your CLI for agents](https://justin.poehnelt.com/posts/rewrite-your-cli-for-ai-agents/) ·
[Playwright CLI](https://github.com/microsoft/playwright-cli) ·
[agents.md](https://agents.md/) · [Agent Skills](https://agentskills.io/) · [llms.txt](https://llmstxt.org/) ·
[MCP tools](https://modelcontextprotocol.io/docs/concepts/tools) ·
[GitHub MCP server](https://github.com/github/github-mcp-server) ·
[Stripe: building with AI](https://docs.stripe.com/building-with-ai) ·
[Terraform plan](https://developer.hashicorp.com/terraform/cli/commands/plan) ·
[kubectl rollout undo](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_rollout/kubectl_rollout_undo/) ·
[Vercel global options](https://vercel.com/docs/cli/global-options) ·
[OpenClaw config CLI](https://docs.openclaw.ai/cli/config)
