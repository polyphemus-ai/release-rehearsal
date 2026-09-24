import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ProviderConfig } from '../config.js';
import type { Vault } from '../secrets/vault.js';
import { PolyphemusError } from '../types.js';

interface StoredCredentials {
  apiKey?: string;
}

/** Where a provider's API key lives in the vault. */
export const providerSecret = (provider: string) => `provider/${provider}`;

/**
 * Provider API keys. They live in the vault; `~/.polyphemus/credentials.json` (phase 1's plain-text
 * stopgap) is still read so nothing breaks, and `migrate()` moves what's left into the vault.
 */
export class Credentials {
  constructor(
    readonly file: string,
    private readonly vault?: Vault,
  ) {}

  private readLegacy(): Record<string, StoredCredentials> {
    if (!existsSync(this.file)) return {};
    try {
      return JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, StoredCredentials>;
    } catch {
      return {};
    }
  }

  apiKey(provider: string, by = 'polyphemus'): string | undefined {
    return this.vault?.get(providerSecret(provider), by) ?? this.readLegacy()[provider]?.apiKey;
  }

  /** Every secret polyphemus holds, so it can mask them if one ever shows up in tool output. */
  allApiKeys(): string[] {
    const legacy = Object.values(this.readLegacy()).flatMap((stored) => (stored.apiKey ? [stored.apiKey] : []));
    return [...(this.vault?.values() ?? []), ...legacy];
  }

  setApiKey(provider: string, apiKey: string): void {
    if (this.vault) return this.vault.set(providerSecret(provider), apiKey, { kind: 'api-key', note: `API key for ${provider}` });
    const all = this.readLegacy();
    all[provider] = { ...all[provider], apiKey };
    this.writeLegacy(all);
  }

  deleteApiKey(provider: string): void {
    this.vault?.remove(providerSecret(provider));
    const all = this.readLegacy();
    if (!all[provider]?.apiKey) return;
    delete all[provider].apiKey;
    if (Object.keys(all[provider]).length === 0) delete all[provider];
    this.writeLegacy(all);
  }

  /** Provider keys still sitting in plain text in credentials.json. */
  legacyProviders(): string[] {
    return Object.entries(this.readLegacy())
      .filter(([, stored]) => stored.apiKey)
      .map(([provider]) => provider)
      .sort();
  }

  /** Moves plain-text keys into the vault, then removes them from credentials.json. Returns what moved. */
  migrate(): string[] {
    if (!this.vault) throw new PolyphemusError('There’s no vault to migrate into.', 'FAILED');
    const all = this.readLegacy();
    const moved: string[] = [];
    for (const [provider, stored] of Object.entries(all)) {
      if (!stored.apiKey) continue;
      this.vault.set(providerSecret(provider), stored.apiKey, { kind: 'api-key', note: `API key for ${provider}` });
      // Only once it's safely in the vault.
      delete stored.apiKey;
      if (Object.keys(stored).length === 0) delete all[provider];
      moved.push(provider);
    }
    if (moved.length > 0) {
      if (Object.keys(all).length === 0) rmSync(this.file, { force: true });
      else this.writeLegacy(all);
    }
    return moved;
  }

  private writeLegacy(all: Record<string, StoredCredentials>): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
    chmodSync(this.file, 0o600);
  }
}

/** Env var first (so it can override per shell), then the vault. */
export function resolveApiKey(providerId: string, config: ProviderConfig, credentials: Credentials): string {
  // A local server wants no key, but the client library insists on a string.
  if (config.auth.type === 'none') return 'no-key-needed';
  const env = config.auth.type === 'api_key' ? config.auth.env : undefined;
  const fromEnv = env ? process.env[env] : undefined;
  const key = fromEnv || credentials.apiKey(providerId);
  if (!key) {
    const envHint = env ? `set ${env}, or ` : '';
    throw new PolyphemusError(`No API key for "${providerId}": ${envHint}run \`poly login ${providerId}\`.`);
  }
  return key;
}
