# Secrets and identity

**Goal:** bots use credentials without ever seeing them. Each bot has its own identity with
only the access it was granted. Every action proves it's aimed at the right account before
it runs. Moving an app to a new AWS account is a one-line change.

## What went wrong in OpenClaw

| Symptom | Mechanism (from the workspace) |
|---|---|
| Agents used each other's credentials | Every agent ran as the same unix user with unsandboxed exec, and `~/.secrets/` was readable by all of them. The ambient `gh` login (`shared-bot`) was picked up by any agent that skipped its project env. One Ledger PAT was shared by every agent. |
| The executor merged its own PRs (#271, #317) | That same shared token had merge rights. "Planner never merges" was a prompt rule, not an enforced one. |
| Stale AWS account after Ledger moved accounts | The default credentials, `deploy.yml`, and a dead key at a default-looking path (`~/.secrets/ledger/ledger-ec2.pem`) all still pointed at the old account, and nothing checked. This contributed to the #85 staging outage. |
| A token in plain text | A GitHub PAT embedded in a `.git/config` remote URL. |

`SECRETS-STANDARD.md` admits it's "convention + TOOLS.md + env, not OS isolation." The
research agrees that conventions don't hold: CLAUDE.md-style rules against reading `.env`
"get ignored under pressure." Only hard boundaries work.

## Principles (industry consensus, Sep 2026)

1. **Bots use credentials they never see.** The sandbox gets a *placeholder*, and a broker
   swaps in the real secret at the network boundary, only for approved hosts. Anthropic
   Managed Agents vaults, Claude Code on the web, Cloudflare, Deno, Vercel, and Infisical all
   do this.
2. **One identity per bot.** Each bot gets its own OS user or sandbox, with only its own home
   directory mounted. A vault isn't a boundary when every process runs as the same user
   (Silverfort showed any same-user process can read the macOS keychain). See OWASP ASI03,
   NHI5, and NHI9.
3. **Short-lived and task-scoped.** Mint credentials per task: AWS AssumeRole for 15–60
   minutes, GitHub App tokens for about an hour limited to named repos. No long-lived keys
   on disk.
4. **Separation of duties is enforced by the platform.** The executor physically *cannot*
   merge because GitHub branch rules stop it, not because a prompt says so.
5. **Identity is asserted, fail-closed.** Before an action runs, the credential proves it's
   the bound account or app. On a mismatch or missing binding, it refuses. There is no
   default fallback.
6. **No ambient credentials.** No default AWS profile, no global `gh` login, no inherited
   secret env vars. `doctor` fails if any exist.
7. **Cut the lethal trifecta** (private data + untrusted content + a way to send data out):
   each bot gets an egress allowlist.
8. **Audit resolutions, never values:** which bot, which reference, which project, the TTL,
   and why.
9. **Grants expire and are inventoried.** Offboarding is explicit (OWASP NHI1; the stale AWS
   key was exactly this).
10. **Redaction is a backstop.** Polyphemus knows every value it hands out, so it scrubs those
    exact strings from tool output and transcripts, plus gitleaks-style patterns for the
    rest.

## Design

### Vault: one backend at launch

| Use | Choice |
|---|---|
| Secret storage | ✅ **A local encrypted vault** (`~/.polyphemus/vault.json`): AES-256-GCM per secret, sealed to its own name, with the key in `~/.polyphemus/vault.key` (0600). Decided 2026-09-11, superseding 1Password-first: it needs no account and runs unattended at boot. **1Password service accounts** via `@1password/sdk` (`op://` references) become a second backend behind the same interface once the plan is confirmed to include service accounts. |
| Polyphemus's own master credential on a desktop | OS keychain via `@napi-rs/keyring` (keytar's replacement). This protects Polyphemus itself; it isn't a boundary between bots. |
| Phone | Holds no agent secrets. The phone is the **approver** for elevated grants; its own login lives in `expo-secure-store`. |

Everything else (config, memory, docs, prompts) holds only references: `secret:aws/bg-prod`.

### Broker

A local daemon component that is the only thing able to read the vault.

- **HTTP APIs** (model providers, SaaS APIs): the bot's process gets a placeholder, and the
  broker's egress proxy injects the real header for allowlisted hosts. This is the Infisical
  Agent Vault / Fly tokenizer pattern with a per-sandbox CA.
- **CLIs that need a real credential** (`aws`, `gh`, `git`): the broker mints a short-lived
  credential and puts it into the environment of *that one subprocess* only. Isolation
  flags come with it: `AWS_CONFIG_FILE=/dev/null`, an empty per-bot `GH_CONFIG_DIR`, and a
  per-bot git credential helper.

### When only you can sign in

Some logins can't be brokered: SSO with a device prompt, a captcha, an account with no API at
all. Grok Bot turns this into a moment rather than a chore — mid-task it puts the site in front
of you, headed "Sign into Salesforce", with an **I'm done, continue** button, and picks the work
back up when you're through (x.ai/bot, seen 2026-09-11).

Polyphemus does the same, as of 2026-09-21, for a connection the thread can already use. The agent
asks with `request_sign_in`. A card in Waiting on you opens the service’s own sign-in (OAuth) or
the browser on this computer (a site). Coming back from that sign-in returns to the thread that
asked, and keeping a site continues it. The password goes to the site, the token or the cookies go
to the vault, and the agent hears that you finished — and, for a site, whether the sign-in is held
back because other people are in the project. A key is still the secret card. A GitHub identity and
Finance are still set up from Connections. A site that keeps its session in `localStorage` rather
than in cookies is kept too, as of 2026-09-22: its stored session goes to the vault beside the
cookies and is put back before the page's own scripts run. Not `sessionStorage`, which dies with the
tab for anyone. A site whose “verify you are human” check refuses the computer polyphemus runs on
can't be signed in there at all — that is the site's call, and polyphemus works around no such check.

### Asking for a secret in a thread (built 2026-09-21, except the broker)

The owner asked for a way to give an agent a credential from a thread, as Grok Bot does. The card
and the paste catcher are built. Using the saved value in a command is still the broker, which is
not. The shape:

- **A card, not an artifact.** An artifact is HTML the model wrote. A form there could label one
  thing and send another, or pass for Polyphemus. The form belongs to Polyphemus: a question in
  Waiting on you (kind `secret`), answerable from any device like an approval.
- **The agent asks by name and purpose**, e.g. `request_secret("aws/polyphemus-site", "deploy the
  site", …)`. It gets back a reference (`secret:aws/polyphemus-site`) and "saved", never the value.
- **The value goes from the app to the vault.** It never enters the thread, the transcript or a
  model's context. Who may use it (this agent, or the project) is chosen on the card, as a grant.
- **A key pasted into chat** is spotted before sending and offered a move to the vault.
  `redact.ts` stays the backstop.
- **It needs the broker.** Providers and connections already read the vault. A general secret used
  by one CLI command needs the broker's env injection, which isn't built (phase 3). The card records
  who it was saved for (this agent, or the project) and tells the agent it has the name only. Where a
  role or a GitHub App identity can do the job instead (OIDC deploys, Polyphemus's GitHub identities),
  that's preferred to a stored key.

### Grants

```toml
# ~/.polyphemus/secrets.toml (references and policy only)
[secrets."aws/bg-prod"]
kind = "aws-role"                 # aws-role | github-app | api-key | env | file
role = "arn:aws:iam::356468128759:role/bot-exec-bg"
grants = [{ bot = "deployer", project = "game-night", expires = "2026-12-31" }]
approval = "phone"                # production grants need a tap from you

[secrets."github/exec-bot"]
kind = "github-app"
grants = [{ bot = "coder" }]      # scoped per task to the run's repo

[secrets."github/review-bot"]
kind = "github-app"
grants = [{ bot = "reviewer" }]

[secrets."provider/anthropic"]
kind = "api-key"
grants = [{ bot = "*" }]
```

**Plugins are granted the same way.** An MCP server is a capability plus, almost always, a
credential, so it belongs in this table rather than a second one of its own:

```toml
[plugins."salesforce"]
kind = "mcp"
command = "npx -y @acme/salesforce-mcp"
secret = "api/salesforce"          # resolved by the broker; the bot never sees it
grants = [{ bot = "bd", project = "acme" }]
```

`{ bot = "*" }` is how something is granted across the whole install — already how the Anthropic
key is granted — and a named bot and project is how it's narrowed. **Organisation-wide and
per-bot are the same mechanism**, so there's no separate plugins screen to keep in sync with
this one. Grok Bot puts Plugins at the account level with no per-bot scoping (x.ai/bot settings,
seen 2026-09-11): one bot gaining Salesforce means every bot has it, which is OpenClaw's
shared-credential failure with better typography.

### Multiplayer: whose secret, whose bot (phase 8)

Two things change when there's more than one person, and neither is a new structure:

- **A project gains an owner and a visibility.** Private agents and private memory already exist
  as the library scope (`~/.polyphemus/agents`, `~/.polyphemus/memory`); in multiplayer that folder is
  simply *your* space on the install, and the project folder is the shared one. A private
  project is an owner plus `visibility = "private"`, not a new kind of thing.
- **A grant gains a person.** A secret is owned by a person or by the organisation, and only its
  owner can grant it.

**The trap: a private credential granted to a shared bot leaks by proxy.** If the owner grants their
personal Salesforce to an agent everyone in the project can talk to, then anyone in that project
can ask that agent to pull from Salesforce. No credential was shared and the data still went
out. So a personal secret granted to a shared agent either refuses, or becomes an explicit
*acts as the owner* that needs the owner's approval on each use. It's OpenClaw's shared-PAT lesson in a
new place: the boundary has to be enforced where the action happens, not where the key is kept.

### Bindings: the AWS and GitHub fix

```toml
# <repo>/.polyphemus/bindings.toml (safe to commit)
[env.prod.aws]
secret = "aws/bg-prod"
account = "356468128759"          # asserted on every use
region = "us-east-1"

[env.prod.github]
secret = "github/exec-bot"
repo = "acme/game-night"
```

Before any AWS or GitHub action in a project, Polyphemus:

1. resolves the binding;
2. mints short-lived credentials;
3. **preflights** the identity (`sts get-caller-identity` must return account 356468128759;
   the GitHub App installation must see exactly the bound repo);
4. refuses on any mismatch, with a clear message.

When an app moves accounts, you edit one binding and run `polyphemus bindings verify`. Memory
notes refer to the binding, so nothing else goes stale.

## One-time setup this implies

**AWS**

1. Delete the static keys in `~/.aws/credentials` and the `[default]` profile.
2. You sign in as a human through IAM Identity Center (`aws sso login`).
3. In each account, create a role per bot and project (`bot-exec-bg`, …) that only your
   Identity Center role (or a Roles Anywhere profile, for unattended runs) can assume.
4. Polyphemus calls AssumeRole with `SourceIdentity=<bot>` and session tags, so CloudTrail
   shows which bot did what.

**GitHub**

1. `gh auth logout` and revoke the shared PAT.
2. Create two GitHub Apps, `exec-bot` and `review-bot`, installed only on the repos they need.
3. Add a ruleset on `main` (private repos on a personal account may need GitHub Pro; to be
   verified):
   - require a PR with 1 approval
   - require approval of the most recent push
   - require status checks
   - allow no bypass except you
4. The executor then *can't* approve or merge its own work.

## Doctor

`poly secrets doctor` fails on any of:

- ambient `AWS_*` or `GH_TOKEN` variables
- a default AWS profile or credentials file
- a global `gh` login
- tokens inside git remotes
- expired or orphaned grants
- bindings whose identity check fails
- key files at default-looking paths

`poly secrets audit` shows the resolution log.

## Build order

| Phase | Work |
|---|---|
| 3 | ✅ Vault (local backend), ✅ provider keys moved out of `credentials.json` (`poly secrets migrate`), ✅ `secret:` references, ✅ audit of resolutions (never values), ✅ `poly secrets doctor`. Still to come: the broker (CLI env injection), grants, and bindings with AWS and GitHub preflight |
| 4 | GitHub Apps and ruleset for the dev pipeline; per-task token minting |
| 6 | Per-bot OS user or sandbox; egress proxy with placeholder injection; per-bot egress allowlists; phone approval for production grants |

Phase 1's `~/.polyphemus/credentials.json` (0600, plain text) is replaced: it's read only so older
installs keep working, and `poly secrets migrate` moves what's in it into the vault and
deletes it. `poly secrets doctor` fails while any key is still sitting there.

**Doctor's scope.** By default it checks Polyphemus's own house only: the vault's files and their
modes, provider keys still in plain text, and variables that override the vault. Any of those
fails (exit 1).

The ambient credentials this design wants gone — `~/.aws/credentials`, a global `gh` login,
`~/.secrets`, `AWS_*` and `GH_TOKEN` in the environment — are behind `--machine`, and reported
as notes rather than failures. They're *your* credentials as a human on this computer; Polyphemus
already refuses those paths in its tools and strips those variables from the environment tools
run in, so it has no business commenting on the rest of your machine unasked. The check exists
(existence only — Polyphemus never reads them) for phase 6, when each bot gets its own identity and
what a bot process could inherit starts to matter.

## Key sources

Anthropic: [Managed Agents vaults](https://platform.claude.com/docs/en/managed-agents/vaults),
[how we contain Claude](https://www.anthropic.com/engineering/how-we-contain-claude),
[Claude Code sandboxing](https://code.claude.com/docs/en/sandbox-environments).
Sandbox and proxy patterns: [Cloudflare sandbox auth](https://blog.cloudflare.com/sandbox-auth/),
[Infisical Agent Vault](https://github.com/Infisical/agent-vault),
[Fly tokenizer](https://github.com/superfly/tokenizer).
OWASP: [agentic Top 10](https://genai.owasp.org/2025/12/09/owasp-top-10-for-agentic-applications-the-benchmark-for-agentic-security-in-the-age-of-autonomous-ai/),
[NHI Top 10](https://owasp.org/www-project-non-human-identities-top-10/2025/top-10-2025/).
[MCP authorization](https://modelcontextprotocol.io/specification/draft/basic/authorization).
[1Password service accounts](https://1password.com/blog/service-accounts-sdks-agentic-ai).
[keyring-node](https://github.com/Brooooooklyn/keyring-node).
[AWS Roles Anywhere](https://docs.aws.amazon.com/rolesanywhere/latest/userguide/credential-helper.html).
[GitHub protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches).
[Silverfort keychain finding](https://www.silverfort.com/blog/skipping-the-lock-a-claude-code-cli-weakness-lets-any-macos-process-read-stored-credentials/).
