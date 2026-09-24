import { ClaudeCodeAgent, GrokBuildAgent } from '../agents/claude-cli.js';
import { CodexAgent } from '../agents/codex-cli.js';
import type { AgentProvider } from '../agents/common.js';
import { Credentials, resolveApiKey } from '../auth/credentials.js';
import type { Config, ProviderConfig } from '../config.js';
import { findOnPath } from '../platform.js';
import { PolyphemusError, type ModelProvider } from '../types.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAIChatProvider } from './openai-chat.js';
import { OpenAIResponsesProvider } from './openai-responses.js';

/** A model API (polyphemus runs the loop) or an agent CLI (the vendor's CLI runs it). */
export type Provider = ModelProvider | AgentProvider;

export function createProvider(id: string, config: ProviderConfig, credentials: Credentials): Provider {
  const cli = { command: config.command, permissionMode: config.permissionMode };
  switch (config.adapter) {
    case 'claude-cli':
      return new ClaudeCodeAgent(id, cli);
    case 'codex-cli':
      return new CodexAgent(id, { ...cli, ...(config.sandbox === false && { sandbox: false }) });
    case 'grok-cli':
      return new GrokBuildAgent(id, cli);
    case 'anthropic':
      return new AnthropicProvider(id, { apiKey: resolveApiKey(id, config, credentials), baseUrl: config.baseUrl });
    case 'openai-chat':
      return new OpenAIChatProvider(id, { apiKey: resolveApiKey(id, config, credentials), baseUrl: config.baseUrl });
    case 'openai-responses':
      return new OpenAIResponsesProvider(id, {
        apiKey: resolveApiKey(id, config, credentials),
        baseUrl: config.baseUrl,
        reasoningSummary: config.reasoningSummary,
        promptCacheKey: config.promptCacheKey,
      });
  }
}

const CLI_COMMANDS: Partial<Record<ProviderConfig['adapter'], string>> = {
  'claude-cli': 'claude',
  'codex-cli': 'codex',
  'grok-cli': 'grok',
};
const CLI_LOGIN: Partial<Record<ProviderConfig['adapter'], string>> = {
  'claude-cli': 'run `claude` once and sign in',
  'codex-cli': 'run `codex login`',
  'grok-cli': 'run `grok login`',
};

export interface ProviderStatus {
  ready: boolean;
  /** What it runs on, or exactly how to set it up. */
  note: string;
  /** Declared, but you haven't said yes to it yet: polyphemus offers it rather than using it. */
  offered?: boolean;
}

/**
 * Whether a provider can be used right now, without calling it: an API
 * provider needs a key; an agent CLI needs to be installed (its own login is
 * checked when it runs).
 */
export function providerStatus(id: string, config: ProviderConfig, credentials: Credentials): ProviderStatus {
  if (config.auth.type === 'cli') {
    const command = config.command ?? CLI_COMMANDS[config.adapter] ?? config.adapter;
    return onPath(command)
      ? { ready: true, note: `your subscription, via \`${command}\`` }
      : { ready: false, note: `\`${command}\` isn't installed (then ${CLI_LOGIN[config.adapter] ?? 'sign in'})` };
  }
  // A server on your own machine: nothing to sign in to.
  if (config.auth.type === 'none') return { ready: true, note: `${config.baseUrl ?? 'an OpenAI-compatible server'}, no key needed` };
  const env = config.auth.env;
  if (env && process.env[env]) return { ready: true, note: `API key from ${env}` };
  if (credentials.apiKey(id)) return { ready: true, note: 'API key saved by `poly login`' };
  return { ready: false, note: `needs an API key: ${env ? `set ${env} or ` : ''}run \`poly login ${id}\`` };
}

function onPath(command: string): boolean {
  return findOnPath(command) !== undefined;
}

/** Creates providers on first use, so a missing key only matters for the provider you pick. */
export class ProviderRegistry {
  private providers = new Map<string, Provider>();
  /** Providers someone handed us, kept apart from the cache so dropping a stale one can't lose them. */
  private overrides = new Map<string, Provider>();

  constructor(
    private config: Config,
    private credentials: Credentials,
  ) {}

  get(id: string): Provider {
    const override = this.overrides.get(id);
    if (override) return override;
    let provider = this.providers.get(id);
    if (!provider) {
      const providerConfig = this.config.providers[id];
      if (!providerConfig) throw new PolyphemusError(`Unknown provider "${id}"`);
      provider = createProvider(id, providerConfig, this.credentials);
      this.providers.set(id, provider);
    }
    return provider;
  }

  /** Use this provider instance for `id` (tests, or embedding polyphemus with a custom provider). */
  use(id: string, provider: Provider): void {
    this.overrides.set(id, provider);
  }

  /**
   * Drop a cached provider, e.g. after its credentials change — a built one captured the old key
   * at construction. Only the cache: one handed to us with `use` is not ours to throw away.
   */
  forget(id: string): void {
    this.providers.delete(id);
  }
}
