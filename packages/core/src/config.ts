import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isIsolationLevel, type IsolationLevel } from './isolation/levels.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { EFFORTS, PolyphemusError, type Effort } from './types.js';

export type Adapter = 'anthropic' | 'openai-responses' | 'openai-chat' | 'claude-cli' | 'codex-cli' | 'grok-cli';
const API_ADAPTERS: readonly Adapter[] = ['anthropic', 'openai-responses', 'openai-chat'];
const CLI_ADAPTERS: readonly Adapter[] = ['claude-cli', 'codex-cli', 'grok-cli'];
const ADAPTERS: readonly Adapter[] = [...API_ADAPTERS, ...CLI_ADAPTERS];

export interface ApiKeyAuth {
  type: 'api_key';
  /** Env var checked before ~/.polyphemus/credentials.json. */
  env?: string;
}

/** The vendor CLI owns its login (`claude`, `codex login`, `grok login`). */
export interface CliAuth {
  type: 'cli';
}

/** A server that needs no key: Ollama, LM Studio, llama.cpp, vLLM on your own machine. */
export interface NoAuth {
  type: 'none';
}

export type AuthConfig = ApiKeyAuth | CliAuth | NoAuth;

export interface ProviderConfig {
  adapter: Adapter;
  baseUrl?: string;
  auth: AuthConfig;
  /** openai-responses: ask for reasoning summaries. */
  reasoningSummary: boolean;
  /** openai-responses: send the session id as prompt_cache_key. */
  promptCacheKey: boolean;
  /** CLI adapters: executable to run instead of claude / codex / grok. */
  command?: string;
  /** CLI adapters: permission mode (claude, grok) or sandbox (codex) used without -y. */
  permissionMode?: string;
  /**
   * codex-cli: false runs Codex without its sandbox, for a computer where the sandbox can't start
   * (codex-sandbox.ts). Commands then run with the owner's full permissions. Only the owner sets it.
   */
  sandbox?: boolean;
}

export interface ModelAlias {
  provider: string;
  model: string;
  effort?: Effort;
  /** Models to try, in order, when this one can't take a turn. Overrides [routing].fallback. */
  fallback?: string[];
}

/** What to do when the current model runs out or is down. */
export type FallbackPolicy = 'ask' | 'continue' | 'pause';
const FALLBACK_POLICIES: readonly FallbackPolicy[] = ['ask', 'continue', 'pause'];

export interface Config {
  /** Unset until the user picks one; polyphemus asks on first run. */
  defaultModel?: string;
  /** The agent a thread is with when nobody picked one: set up on first run. */
  defaultAgent?: string;
  /** Where new projects are created; may start with ~. */
  projectsRoot: string;
  providers: Record<string, ProviderConfig>;
  /**
   * The models you've chosen to use, as `provider:model-id`. This is the list the app offers
   * everywhere a model is picked, and the pool fallback draws from. A plain list rather than
   * named tables on purpose: a model id like `gpt-5.6-sol` can't be a TOML table key without
   * quoting, and nothing here needs a name — you pick a provider and then one of its models.
   */
  selected: string[];
  /**
   * The providers you've said yes to. polyphemus ships with several declared, but a fresh install
   * offers them rather than using them: until one is accepted it runs nothing and nobody picks its
   * models. Unset (an install from before offers) means every declared provider is in use.
   */
  accepted?: string[];
  /** Short names for models you use often (`-m fast`). Optional; picking a model doesn't need one. */
  models: Record<string, ModelAlias>;
  /**
   * allowMetered: may a fallback move you from a plan onto a connection billed per token? Off unless
   * you say so, so running out of a subscription never quietly starts a bill.
   */
  /** quotaRetryMinutes: how long a quota error that gave no reset keeps a provider out (quota.ts). */
  routing: { fallback: string[]; onFallback: FallbackPolicy; allowMetered: boolean; quotaRetryMinutes: number };
  permissions: { allow: string[] };
  /** Whether an installed polyphemus asks npm, once a day, if there's a newer version. */
  updates: { check: boolean; channel: UpdateChannel };
  /** Where agents' commands and file changes run, for the whole install (docs/design/isolation.md). */
  isolation: {
    level: IsolationLevel;
    /** Whether the config says so, rather than falling back to the default: installs from before the default was Isolated are kept as they were. */
    chosen: boolean;
  };
}

/** Which releases an install follows: stable ones, or betas too (npm's `latest` and `next` tags). */
export type UpdateChannel = 'stable' | 'beta';

export interface ResolvedModel extends ModelAlias {
  /** What the user calls it: an alias name, or provider:model. */
  label: string;
}

/** A setting from the environment: `POLYPHEMUS_<name>`. */
export function envSetting(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[`POLYPHEMUS_${name}`];
}

/** Where polyphemus keeps its state: ~/.polyphemus, or `POLYPHEMUS_HOME`. */
export function polyphemusHome(): string {
  return envSetting('HOME') ?? join(homedir(), '.polyphemus');
}

/** A project's own polyphemus folder: agents, skills, routines, project.toml. */
export function projectStateDir(projectRoot: string): string {
  return join(projectRoot, '.polyphemus');
}

export const DEFAULT_CONFIG = `# Polyphemus configuration. See docs/DESIGN.md in the polyphemus repo.

# Model for new sessions: an alias below, a provider name, or "provider:model-id".
# Left unset, polyphemus asks you to pick one the first time it runs. Change it any
# time with /default in a session, or pick per session with -m.
# default_model = "claude"

# The models you use, as "provider:model-id". Pick them in the app (You → Models):
# these are what every model picker offers and what fallback draws from. A top-level
# setting, so it stays above the [providers] tables.
selected = []

# The providers below you've chosen to use. The rest are offered, not used: polyphemus won't run
# them or poll their usage until you accept one (You → Providers → Use it).
accepted = []

# Where new projects go (poly projects new, or New project in the app). Your code
# lives here, not inside ~/.polyphemus. Existing folders can be added from anywhere with
# poly projects add <folder>.
# projects_root = "~/projects"

# ── Subscription agents ───────────────────────────────────────────────
# The vendor's own CLI runs the agent loop on your plan and owns its login.
# permission_mode applies when you don't pass -y
# (claude, grok: default | acceptEdits | plan; codex sandbox: read-only | workspace-write).

[providers.claude-code]
adapter = "claude-cli"            # Claude Pro/Max: sign in by running \`claude\`

[providers.codex]
adapter = "codex-cli"             # ChatGPT plans: sign in with \`codex login\`

[providers.grok-build]
adapter = "grok-cli"              # SuperGrok: sign in with \`grok login\`

# ── Pay-as-you-go APIs ────────────────────────────────────────────────
# Polyphemus runs the loop with its own tools. Keys come from the env var or
# \`poly login <provider>\`.

[providers.anthropic]
adapter = "anthropic"
auth = { type = "api_key", env = "ANTHROPIC_API_KEY" }

[providers.openai]
adapter = "openai-responses"
auth = { type = "api_key", env = "OPENAI_API_KEY" }

[providers.xai]
adapter = "openai-responses"
base_url = "https://api.x.ai/v1"
auth = { type = "api_key", env = "XAI_API_KEY" }
# Not yet verified against xAI's Responses API; flip on once confirmed.
reasoning_summary = false
prompt_cache_key = false

# ── Bring your own models ─────────────────────────────────────────────
# Any server that speaks the OpenAI chat API works with adapter = "openai-chat":
# your own machine (no key needed), or a gateway that reaches hundreds of models.
# Uncomment one, then pick its models with: poly models add <name> <provider>:<model-id>
# (\`poly models --all\` lists what a provider offers.)

# [providers.ollama]                 # ollama serve
# adapter = "openai-chat"
# base_url = "http://127.0.0.1:11434/v1"
# auth = { type = "none" }

# [providers.lmstudio]               # LM Studio's local server
# adapter = "openai-chat"
# base_url = "http://127.0.0.1:1234/v1"
# auth = { type = "none" }

# [providers.openrouter]             # hundreds of models behind one key
# adapter = "openai-chat"
# base_url = "https://openrouter.ai/api/v1"
# auth = { type = "api_key", env = "OPENROUTER_API_KEY" }

# [providers.groq]
# adapter = "openai-chat"
# base_url = "https://api.groq.com/openai/v1"
# auth = { type = "api_key", env = "GROQ_API_KEY" }

# [providers.deepseek]
# adapter = "openai-chat"
# base_url = "https://api.deepseek.com"
# auth = { type = "api_key", env = "DEEPSEEK_API_KEY" }

# [providers.gemini]                 # Google's OpenAI-compatible endpoint
# adapter = "openai-chat"
# base_url = "https://generativelanguage.googleapis.com/v1beta/openai"
# auth = { type = "api_key", env = "GEMINI_API_KEY" }

# [providers.mistral]
# adapter = "openai-chat"
# base_url = "https://api.mistral.ai/v1"
# auth = { type = "api_key", env = "MISTRAL_API_KEY" }

# ── Short names for /model and -m ─────────────────────────────────────
# model = "default" lets a CLI use its own default model.
# Optional: effort = "low" | "medium" | "high" | "xhigh" | "max" (API providers)

[models.claude]
provider = "claude-code"
model = "default"

[models.codex]
provider = "codex"
model = "default"

[models.grok]
provider = "grok-build"
model = "default"

[models.claude-api]
provider = "anthropic"
model = "claude-opus-5"

[models.gpt-api]
provider = "openai"
model = "gpt-6-astra"

[models.grok-api]
provider = "xai"
model = "grok-4.6"

# ── When a model runs out ─────────────────────────────────────────────
# If the model you're using hits a limit or is down, polyphemus offers the next one.
#   fallback     models to try, in order (aliases or provider:model). Left empty,
#                polyphemus offers whatever else is ready and lets you pick.
#   on_fallback  "ask": ask before switching (default). "continue": switch and
#                tell you (needs a fallback list). "pause": just stop.
#   allow_metered  let a fallback move you off a subscription onto an API key
#                billed per token. Off unless you turn it on.
# A model can have its own list, e.g. under [models.claude]: fallback = ["codex", "claude-api"]
[routing]
fallback = []
on_fallback = "ask"
allow_metered = false

[permissions]
# Polyphemus tools that run without asking, e.g. ["bash", "edit_file"]. read_file never asks.
# (Agent CLIs use permission_mode above instead.)
allow = []

[updates]
# Once a day, an installed polyphemus asks npm whether there's a newer version. Nothing about you or
# this computer is sent. Set to false to never ask.
check = true
# "stable", or "beta" to get releases before they're called stable (and stable ones when they're
# newer). Switch with: poly update --channel beta
channel = "stable"
`;

// A new install writes its level down, so that once it has threads it isn't mistaken for one that was
// in use before Isolated was the default (Polyphemus.open keeps those on this computer).
const NEW_INSTALL_CONFIG = `${DEFAULT_CONFIG}
[isolation]
# Where agents' commands and file changes run: "isolated" (a container with only the project, and
# network only to hosts you grant), "isolated-open" (the same, with any public host) or "host"
# (on this computer).
level = "isolated"
`;

/** Declared but not accepted: polyphemus offers it, and doesn't use it until you say so. */
export const isOffered = (config: Config, provider: string): boolean => config.accepted !== undefined && !config.accepted.includes(provider);

/** Billed per token: an API key, as opposed to a plan behind a CLI or a server you run. */
export const isMetered = (config: Config, provider: string): boolean => config.providers[provider]?.auth.type === 'api_key';

export function configFile(home = polyphemusHome()): string {
  return join(home, 'config.toml');
}

export function loadConfig(home = polyphemusHome()): Config {
  const file = configFile(home);
  if (!existsSync(file)) {
    mkdirSync(home, { recursive: true });
    writeFileSync(file, NEW_INSTALL_CONFIG);
  }
  return parseConfig(readFileSync(file, 'utf8'), file);
}

type Table = Record<string, unknown>;

const asTable = (value: unknown): Table =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Table) : {};

const optionalString = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

const isStringList = (value: unknown): boolean => Array.isArray(value) && value.every((item) => typeof item === 'string');

export function parseConfig(text: string, source = 'config.toml'): Config {
  const fail = (message: string): never => {
    throw new PolyphemusError(`${source}: ${message}`);
  };

  let raw: Table;
  try {
    raw = parse(text) as Table;
  } catch (err) {
    return fail((err as Error).message);
  }

  const providers: Record<string, ProviderConfig> = {};
  for (const [id, value] of Object.entries(asTable(raw.providers))) {
    const p = asTable(value);
    if (!ADAPTERS.includes(p.adapter as Adapter)) fail(`providers.${id}.adapter must be one of: ${ADAPTERS.join(', ')}`);
    const adapter = p.adapter as Adapter;
    const auth = asTable(p.auth);
    let authConfig: AuthConfig;
    if (CLI_ADAPTERS.includes(adapter)) {
      if (p.auth !== undefined && auth.type !== 'cli') fail(`providers.${id}.auth.type must be "cli" for ${adapter} (the CLI owns its login)`);
      authConfig = { type: 'cli' };
    } else {
      if (auth.type === 'none') authConfig = { type: 'none' };
      else if (auth.type === 'api_key') authConfig = { type: 'api_key', env: optionalString(auth.env) };
      else return fail(`providers.${id}.auth.type must be "api_key", or "none" for a local server (OAuth is planned)`);
    }
    providers[id] = {
      adapter,
      baseUrl: optionalString(p.base_url),
      auth: authConfig,
      reasoningSummary: p.reasoning_summary !== false,
      promptCacheKey: p.prompt_cache_key !== false,
      command: optionalString(p.command),
      permissionMode: optionalString(p.permission_mode),
      ...(p.sandbox !== undefined && { sandbox: p.sandbox === false ? false : p.sandbox === true ? true : fail(`providers.${id}.sandbox must be true or false`) }),
    };
    if (p.sandbox === false && adapter !== 'codex-cli') fail(`providers.${id}.sandbox only applies to Codex (adapter "codex-cli")`);
  }

  const models: Record<string, ModelAlias> = {};
  for (const [name, value] of Object.entries(asTable(raw.models))) {
    const m = asTable(value);
    const provider = optionalString(m.provider) ?? fail(`models.${name}.provider is required`);
    if (!providers[provider]) fail(`models.${name}.provider "${provider}" is not defined under [providers]`);
    const model = optionalString(m.model) ?? fail(`models.${name}.model is required ("default" lets a CLI choose)`);
    if (m.effort !== undefined && !EFFORTS.includes(m.effort as Effort)) fail(`models.${name}.effort must be one of: ${EFFORTS.join(', ')}`);
    if (m.fallback !== undefined && !isStringList(m.fallback)) fail(`models.${name}.fallback must be a list of model names`);
    models[name] = {
      provider,
      model,
      ...(m.effort !== undefined && { effort: m.effort as Effort }),
      ...(m.fallback !== undefined && { fallback: m.fallback as string[] }),
    };
  }

  // The models you've chosen to use. Each is "provider:model-id"; the provider has to exist, but
  // the model id is the provider's business, not polyphemus's to vet.
  const selectedRaw = raw.selected ?? [];
  if (!isStringList(selectedRaw)) fail('selected must be a list like ["anthropic:claude-opus-5"]');
  const selected: string[] = [];
  for (const ref of selectedRaw as string[]) {
    const at = ref.indexOf(':');
    if (at <= 0 || at === ref.length - 1) fail(`selected "${ref}" must be provider:model-id`);
    const provider = ref.slice(0, at);
    if (!providers[provider]) fail(`selected "${ref}": there's no provider called "${provider}"`);
    if (!selected.includes(ref)) selected.push(ref);
  }

  // Providers you've accepted. One that has since been removed is simply not there any more.
  const acceptedRaw = raw.accepted;
  if (acceptedRaw !== undefined && !isStringList(acceptedRaw)) fail('accepted must be a list of provider names, like ["claude-code"]');
  const accepted = acceptedRaw === undefined ? undefined : [...new Set(acceptedRaw as string[])].filter((id) => providers[id]);

  const routingTable = asTable(raw.routing);
  const fallback = routingTable.fallback ?? [];
  if (!isStringList(fallback)) fail('routing.fallback must be a list of model names');
  const onFallback = routingTable.on_fallback ?? 'ask';
  if (!FALLBACK_POLICIES.includes(onFallback as FallbackPolicy)) fail('routing.on_fallback must be "ask", "continue", or "pause"');

  const allowMetered = routingTable.allow_metered ?? false;
  if (typeof allowMetered !== 'boolean') fail('routing.allow_metered must be true or false');
  const quotaRetryMinutes = routingTable.quota_retry_minutes ?? 60;
  if (typeof quotaRetryMinutes !== 'number' || !Number.isInteger(quotaRetryMinutes) || quotaRetryMinutes < 5 || quotaRetryMinutes > 1440) fail('routing.quota_retry_minutes must be a whole number of minutes, 5 to 1440');

  const allow = asTable(raw.permissions).allow ?? [];
  if (!Array.isArray(allow) || !allow.every((t) => typeof t === 'string')) fail('permissions.allow must be a list of tool names');

  if (raw.projects_root !== undefined && typeof raw.projects_root !== 'string') fail('projects_root must be a folder path, like "~/projects"');
  if (asTable(raw.updates).check !== undefined && typeof asTable(raw.updates).check !== 'boolean') fail('updates.check must be true or false');
  if (asTable(raw.updates).channel !== undefined && !['stable', 'beta'].includes(String(asTable(raw.updates).channel))) fail('updates.channel must be "stable" or "beta"');
  // Isolated by default, now vendor CLIs and workflow runs can be (isolation.md, decided).
  const level = asTable(raw.isolation).level ?? 'isolated';
  if (!isIsolationLevel(level)) fail('isolation.level must be "isolated", "isolated-open" or "host"');

  const config: Config = {
    defaultModel: optionalString(raw.default_model),
    defaultAgent: optionalString(raw.default_agent),
    projectsRoot: optionalString(raw.projects_root) ?? '~/projects',
    providers,
    selected,
    ...(accepted !== undefined && { accepted }),
    models,
    routing: { fallback: fallback as string[], onFallback: onFallback as FallbackPolicy, allowMetered: allowMetered as boolean, quotaRetryMinutes: quotaRetryMinutes as number },
    permissions: { allow: allow as string[] },
    updates: { check: asTable(raw.updates).check !== false, channel: asTable(raw.updates).channel === 'beta' ? 'beta' : 'stable' },
    isolation: { level: level as IsolationLevel, chosen: asTable(raw.isolation).level !== undefined },
  };
  for (const ref of [...config.routing.fallback, ...Object.values(models).flatMap((m) => m.fallback ?? [])]) {
    try {
      resolveModel(config, ref);
    } catch (err) {
      fail(`fallback "${ref}": ${(err as Error).message}`);
    }
  }
  if (config.defaultModel) {
    try {
      resolveModel(config, config.defaultModel);
    } catch (err) {
      fail(`default_model: ${(err as Error).message}`);
    }
  }
  return config;
}

/**
 * Sets `default_model` in the config file, keeping everything else (comments
 * included). The result is validated before anything is written.
 */
export function setDefaultModel(file: string, ref: string): void {
  const text = readFileSync(file, 'utf8');
  const line = `default_model = ${JSON.stringify(ref)}`;
  const existing = /^[ \t]*#?[ \t]*default_model[ \t]*=.*$/m;
  const updated = existing.test(text) ? text.replace(existing, line) : `${line}\n${text}`;
  parseConfig(updated, file);
  writeFileSync(file, updated);
}

/** Resolves an alias ("claude"), a provider name ("grok-build"), or a "provider:model-id" reference. */
export function resolveModel(config: Config, ref: string): ResolvedModel {
  const alias = config.models[ref];
  if (alias) return { label: ref, ...alias };

  const provider = config.providers[ref];
  if (provider) {
    const named = Object.entries(config.models).find(([, m]) => m.provider === ref);
    if (named) return { label: named[0], ...named[1] };
    if (provider.auth.type === 'cli') return { label: ref, provider: ref, model: 'default' };
    throw new PolyphemusError(`"${ref}" needs a model: use ${ref}:<model-id> (see \`poly models\`).`);
  }

  const colon = ref.indexOf(':');
  if (colon > 0 && colon < ref.length - 1) {
    const provider = ref.slice(0, colon);
    if (!config.providers[provider]) {
      throw new PolyphemusError(`Unknown provider "${provider}". Configured: ${Object.keys(config.providers).join(', ')}`);
    }
    return { label: ref, provider, model: ref.slice(colon + 1) };
  }
  throw new PolyphemusError(
    `Unknown model "${ref}". Use an alias (${Object.keys(config.models).join(', ')}) or provider:model-id.`,
  );
}

/**
 * Why a model may not run here, or undefined when it may. Your list of models is the limit on what
 * anything runs on — an agent, a thread, a fallback, whoever set it: a model can cost far more than
 * the ones you chose, and nothing should reach it without you putting it there. Short names you
 * defined under [models] are yours too. With nothing chosen yet there's no list to hold to.
 */
export function offList(config: Config, model: { provider: string; model: string }): string | undefined {
  if (!config.selected.length) return undefined;
  const target = `${model.provider}:${model.model}`;
  if (config.selected.includes(target)) return undefined;
  if (Object.values(config.models).some((m) => m.provider === model.provider && m.model === model.model)) return undefined;
  return `${target} isn’t on your models list, so polyphemus won’t run it. Add it under Setup → Models, or pick one that’s there.`;
}

/** The alias for a provider/model pair if one exists, else provider:model. */
export function modelFor(config: Config, provider: string, model: string): ResolvedModel {
  for (const [name, alias] of Object.entries(config.models)) {
    if (alias.provider === provider && alias.model === model) return { label: name, ...alias };
  }
  return { label: `${provider}:${model}`, provider, model };
}
