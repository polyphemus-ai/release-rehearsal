# Plugins and one-tap connections

Polyphemus installs the plugins people already write for Cursor and Claude Code, and connects to a
service by its name or its address with nothing to configure. Decided 2026-09-29; built before the
first release.

## What a plugin is

A folder with a manifest, in one of two nearly identical formats:

| | Cursor | Claude Code |
|---|---|---|
| Manifest | `.cursor-plugin/plugin.json` | `.claude-plugin/plugin.json` (optional: a marketplace entry can stand in) |
| Skills | `skills` (paths or globs), `SKILL.md` each | `skills/` by default |
| Agents | `agents`: markdown with frontmatter (`name`, `description`, `model`, `readonly`) | `agents/` by default, the same shape (`model: sonnet`…) |
| Rules | `rules`: `.mdc` with `description`, `alwaysApply`, `globs` | — |
| MCP servers | `mcpServers`: a path, an object, or both | `.mcp.json` at its root (with or without an `mcpServers` wrapper) |
| Settings it asks for | `variables` (JSON schema) | `userConfig` |
| Hooks, commands | `hooks`, `commands` | `hooks/hooks.json`, `commands/`, `lspServers`, `outputStyles` |

Polyphemus reads either into one shape, and says which parts it will use and which it won't.

## Where plugins come from

- **Marketplaces:** Cursor's (`cursor/plugins`, about 85) and Claude Code's official directory
  (`anthropics/claude-plugins-official`, about 300), and any other marketplace repository the owner
  adds. An entry is a folder in the marketplace, a folder in another git repository, or a whole
  repository — the external ones pinned to a commit.
- **A git address or a folder on this computer**, for one that isn't in a marketplace.

A plugin is fetched at its pinned commit (or the marketplace's current one) with git, into
`~/.polyphemus/cache/plugins/`, and read from there. Nothing in it runs to install it.

## What each part becomes

| Part | Becomes | Notes |
|---|---|---|
| Skills | Skills in the library or the project, the same format | Their origin records the plugin, its version, source and commit, and its licence |
| Agents | Polyphemus agents: title, description, persona from the body, model from `model` where it names one this install has | `readonly` becomes the agent's read-only mode; a tool list isn't carried over |
| Rules | Proposals in the project's Review, to keep in `AGENTS.md` or discard | Never written into a project directly |
| MCP servers | Connections, owned by the person installing, granted to the project only when they tick its tools | Keys a server needs are asked for and kept in the vault. A server that runs a command (`npx …`, `bun run …`) runs code on this computer, and is said so before it's added |
| Settings | Asked for when installing; a secret goes to the vault | |
| Hooks, commands, LSP servers, output styles | Not used | Listed as not used, never run |

**Installing is the owner's**, and shows everything it will add before anything happens. What was
added is recorded (`~/.polyphemus/plugins/<id>.json`), so **removing** a plugin removes exactly
that: skills and agents it added and nobody has changed since (a changed one stays, and is named),
and — asked separately — its connections.

**What a plugin's text says is data.** Its skills and agents become instructions agents read, like
any library skill: from a source the owner chose, shown before it's installed, never with more
reach than the grants of the thread it's used in.

## One-tap connections

- **The catalogue** gains the services whose MCP servers let any app sign in by dynamic client
  registration, which polyphemus already does. 35 of the 57 in Cursor's list that the catalogue
  lacked, checked 2026-09-29. `scripts/connections-check.mjs` asks each one again — its published
  sign-in rules, a registration, and whether signing in reaches the service's own sign-in page — so
  one that changes is found before someone taps it. A last step needs an account: that is tried by a
  person, once, before an entry is called working.
- **Any other address:** pasting an MCP server's address works out how it signs in — OAuth with
  discovery and registration, a key, or none — and asks only for what it needs.
- Services that take only apps their vendor has approved (HubSpot, Zoom, Google Calendar…) need
  Polyphemus registered with each vendor. Not yet.

## The directory

Connections, Skills and Plugins are one place with a switch at the top, the way Claude, ChatGPT and
Grok show theirs. Connections has **Yours** and **Discover**: cards with the service's logo, its
name, a check for an entry Polyphemus has checked itself, two lines on what it does, who it's by,
and + (or ✓ when it's added). Popular services first, then the catalogue's categories, then the open
[MCP Registry](https://registry.modelcontextprotocol.io).

- **Logos** are Simple Icons (CC0), bundled in the app as `brand-icons.json` by
  `scripts/brand-icons.mjs` — about half the catalogue. The rest get their initial on their brand
  colour. Nothing is fetched from a service to draw it: the app's pages don't reach out.
- **The MCP Registry** is read in the background into `~/.polyphemus/cache/mcp-registry.json` and
  kept a day. Only servers at a plain https address over streamable HTTP are offered (about 14,000
  on 2026-09-29); the ones the catalogue has, by host, are left to the catalogue. A server's
  publisher is the domain its name proves (`com.example/…` is example.com's; `io.github.sam/…` is a
  GitHub account's), and a domain ranks before an account in search. Polyphemus hasn't checked
  these, and says so: + opens the address form filled in — address, name, and the header its key
  goes in when the registry names one — and it finds out there how it signs in.
- A page that fails is asked for once more; after that, what was read is kept and marked partial.

## Order

1. Read both formats into one shape; fetch from marketplaces, git and folders (core, tested against
   real plugins from both marketplaces).
2. Install and remove: skills, agents, rules as proposals, MCP servers as connections, settings.
   `poly plugins` in the terminal.
3. The app: Plugins — browse the marketplaces, see what a plugin would add, install it for the
   library or a project, remove it.
4. One-tap connections: the catalogue additions, the check script, and connecting by address.
