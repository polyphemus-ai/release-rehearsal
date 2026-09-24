import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, parseConfig, resolveModel } from '../src/config.js';
import { QUOTA_RETRY_MS, resetFromMessage } from '../src/quota.js';
import { canFallBack, fallbackCandidates, outReading } from '../src/routing.js';
import { ProviderError } from '../src/types.js';

const subscriptionsOnly = (provider: string) => ['claude-code', 'codex', 'grok-build'].includes(provider);
const withList = parseConfig(DEFAULT_CONFIG.replace('fallback = []', 'fallback = ["codex", "grok", "claude-api"]'));

describe('fallbackCandidates', () => {
  it('follows the fallback list in order, skipping the current provider and anything not ready or out', () => {
    const { candidates, explicit } = fallbackCandidates(withList, resolveModel(withList, 'claude'), {
      isReady: subscriptionsOnly,
      isOut: (p) => p === 'grok-build',
    });
    expect(explicit).toBe(true);
    expect(candidates.map((c) => c.label)).toEqual(['codex']);
  });

  it('falls back only onto models on your list, even when a fallback list names another', () => {
    const listed = parseConfig(DEFAULT_CONFIG.replace('selected = []', 'selected = ["codex:gpt-5"]').replace('fallback = []', 'fallback = ["codex:gpt-5", "grok-build:grok-9-pricey"]'));
    const { candidates } = fallbackCandidates(listed, resolveModel(listed, 'claude'), { isReady: () => true, isOut: () => false });
    expect(candidates.map((c) => c.label)).toEqual(['codex:gpt-5']);
  });

  it('skips providers already tried this turn', () => {
    const { candidates } = fallbackCandidates(withList, resolveModel(withList, 'claude-api'), {
      isReady: () => true,
      isOut: () => false,
      tried: new Set(['codex']),
    });
    expect(candidates.map((c) => c.label)).toEqual(['grok']);
  });

  it('won’t move you from a plan onto a per-token bill unless you allow it', () => {
    const everythingReady = { isReady: () => true, isOut: () => false };
    const off = fallbackCandidates(withList, resolveModel(withList, 'claude'), everythingReady);
    expect(off.candidates.map((c) => c.label)).toEqual(['codex', 'grok']);
    expect(off.skippedMetered.map((c) => c.label)).toEqual(['claude-api']);

    const allowed = parseConfig(DEFAULT_CONFIG.replace('fallback = []', 'fallback = ["codex", "claude-api"]').replace('allow_metered = false', 'allow_metered = true'));
    expect(fallbackCandidates(allowed, resolveModel(allowed, 'claude'), everythingReady).candidates.map((c) => c.label)).toEqual(['codex', 'claude-api']);

    // Already paying per token: moving to another API isn't a new kind of cost.
    const onApi = parseConfig(DEFAULT_CONFIG.replace('fallback = []', 'fallback = ["gpt-api", "codex"]'));
    expect(fallbackCandidates(onApi, resolveModel(onApi, 'claude-api'), everythingReady).candidates.map((c) => c.label)).toEqual(['gpt-api', 'codex']);
    // And with no list, an API key is never even suggested from a plan.
    const bare = parseConfig(DEFAULT_CONFIG);
    const suggested = fallbackCandidates(bare, resolveModel(bare, 'claude'), everythingReady).candidates;
    expect(suggested.every((c) => ['codex', 'grok-build'].includes(c.provider))).toBe(true);
  });

  it('only suggests (explicit = false) when there is no list', () => {
    const config = parseConfig(DEFAULT_CONFIG);
    const { candidates, explicit } = fallbackCandidates(config, resolveModel(config, 'claude'), { isReady: subscriptionsOnly, isOut: () => false });
    expect(explicit).toBe(false);
    expect(candidates.map((c) => c.label)).toEqual(['codex', 'grok']);
  });

  it("uses a model's own list over the global one", () => {
    const config = parseConfig(
      DEFAULT_CONFIG.replace('fallback = []', 'fallback = ["codex"]').replace(
        '[models.claude]\nprovider = "claude-code"\nmodel = "default"',
        '[models.claude]\nprovider = "claude-code"\nmodel = "default"\nfallback = ["grok"]',
      ),
    );
    const { candidates } = fallbackCandidates(config, resolveModel(config, 'claude'), { isReady: () => true, isOut: () => false });
    expect(candidates.map((c) => c.label)).toEqual(['grok']);
  });
});

describe('routing rules', () => {
  it('falls back on limits and outages, never on auth or bad requests', () => {
    expect(canFallBack(new ProviderError('out', 'quota_exhausted', 'grok-build'))).toBe(true);
    expect(canFallBack(new ProviderError('slow down', 'rate_limited', 'codex'))).toBe(true);
    expect(canFallBack(new ProviderError('busy', 'overloaded', 'anthropic'))).toBe(true);
    expect(canFallBack(new ProviderError('bad key', 'auth', 'anthropic'))).toBe(false);
    expect(canFallBack(new ProviderError('bad request', 'invalid_request', 'openai'))).toBe(false);
    expect(canFallBack(new Error('boom'))).toBe(false);
  });

  it('knows when a provider is out', () => {
    expect(outReading([{ window: 'quota', usedPct: 100 }])).toMatchObject({ window: 'quota' });
    expect(outReading([{ window: '7d', usedPct: 98 }, { window: '5h', usedPct: 100 }])).toMatchObject({ window: '5h' });
    expect(outReading([{ window: '7d', usedPct: 98 }])).toBeUndefined();
    expect(outReading(undefined)).toBeUndefined();
  });

  it('refuses a sandbox setting on anything but Codex', () => {
    expect(parseConfig(DEFAULT_CONFIG.replace('adapter = "codex-cli"', 'adapter = "codex-cli"\nsandbox = false')).providers.codex!.sandbox).toBe(false);
    expect(() => parseConfig(DEFAULT_CONFIG.replace('adapter = "grok-cli"', 'adapter = "grok-cli"\nsandbox = false'))).toThrow('only applies to Codex');
    expect(() => parseConfig(DEFAULT_CONFIG.replace('adapter = "codex-cli"', 'adapter = "codex-cli"\nsandbox = "no"'))).toThrow('must be true or false');
  });

  it('keeps a quota error out only until its reset, or for an hour when it gave none', () => {
    const now = Date.now();
    const at = (msAgo: number) => new Date(now - msAgo);
    // No reset known: out for QUOTA_RETRY_MS after it happened, then tried again.
    expect(outReading([{ window: 'quota', usedPct: 100, observedAt: at(10 * 60_000) }], now)).toMatchObject({ window: 'quota' });
    expect(outReading([{ window: 'quota', usedPct: 100, observedAt: at(QUOTA_RETRY_MS) }], now)).toBeUndefined();
    expect(outReading([{ window: 'quota', usedPct: 100, observedAt: at(3 * 86_400_000) }], now)).toBeUndefined();
    // A reset it did give is used instead, however far off.
    expect(outReading([{ window: 'quota', usedPct: 100, observedAt: at(3 * 3_600_000), resetsAt: new Date(now + 3_600_000) }], now)).toMatchObject({ window: 'quota' });
    expect(outReading([{ window: 'quota', usedPct: 100, observedAt: at(60_000), resetsAt: new Date(now - 1) }], now)).toBeUndefined();
    expect(outReading([{ window: '5h', usedPct: 100, resetsAt: new Date(now - 1) }], now)).toBeUndefined();
  });

  it('reads a relative reset time out of an error message', () => {
    const now = 1_000_000;
    expect(resetFromMessage("You've hit your usage limit. Try again in 2 hours 5 minutes.", now)?.getTime()).toBe(now + 2 * 3_600_000 + 5 * 60_000);
    expect(resetFromMessage('quota exceeded, resets in 30m', now)?.getTime()).toBe(now + 30 * 60_000);
    expect(resetFromMessage('Grok Build usage balance exhausted', now)).toBeUndefined();
  });

  it('validates routing config', () => {
    expect(withList.routing).toEqual({ fallback: ['codex', 'grok', 'claude-api'], onFallback: 'ask', allowMetered: false, quotaRetryMinutes: 60 });
    expect(() => parseConfig(DEFAULT_CONFIG.replace('allow_metered = false', 'allow_metered = "yes"'))).toThrow('routing.allow_metered');
    expect(() => parseConfig(DEFAULT_CONFIG.replace('allow_metered = false', 'allow_metered = false\nquota_retry_minutes = 1'))).toThrow('routing.quota_retry_minutes');
    expect(parseConfig(DEFAULT_CONFIG.replace('allow_metered = false', 'allow_metered = false\nquota_retry_minutes = 30')).routing.quotaRetryMinutes).toBe(30);
    expect(parseConfig(DEFAULT_CONFIG).routing.quotaRetryMinutes).toBe(60);
    expect(() => parseConfig(DEFAULT_CONFIG.replace('on_fallback = "ask"', 'on_fallback = "maybe"'))).toThrow('routing.on_fallback');
    expect(() => parseConfig(DEFAULT_CONFIG.replace('fallback = []', 'fallback = ["nope"]'))).toThrow('fallback "nope"');
  });

  it('offers a provider you can use even when nothing is named on it', () => {
    // Being unnamed is a gap in your config, not a reason to be stranded when your model runs out.
    const config = parseConfig(DEFAULT_CONFIG.replace(/\[models\.[\s\S]*?(?=# ── When a model runs out)/, ''));
    expect(Object.keys(config.models)).toEqual([]);
    const { candidates, explicit } = fallbackCandidates(config, resolveModel(config, 'claude-code'), {
      isReady: (p) => p === 'codex' || p === 'openai',
      isOut: () => false,
      // A CLI picks its own model; an API provider is only offered an id we've seen work.
      knownModel: (p) => (p === 'openai' ? 'gpt-6-astra' : undefined),
    });
    expect(explicit).toBe(false);
    // openai is billed per token, so from a plan it's not offered without allow_metered.
    expect(candidates.map((c) => c.label).sort()).toEqual(['codex:default']);
    const fromApi = fallbackCandidates(config, resolveModel(config, 'anthropic:claude-opus-5'), {
      isReady: (p) => p === 'codex' || p === 'openai',
      isOut: () => false,
      knownModel: (p) => (p === 'openai' ? 'gpt-6-astra' : undefined),
    });
    expect(fromApi.candidates.map((c) => c.label).sort()).toEqual(['codex:default', 'openai:gpt-6-astra']);
  });

  it('will not guess a model id for an API provider it has never used', () => {
    const config = parseConfig(DEFAULT_CONFIG.replace(/\[models\.[\s\S]*?(?=# ── When a model runs out)/, ''));
    const { candidates } = fallbackCandidates(config, resolveModel(config, 'claude-code'), {
      isReady: (p) => p === 'openai',
      isOut: () => false,
      knownModel: () => undefined,
    });
    expect(candidates).toEqual([]);
  });

  it('leaves an explicit chain alone', () => {
    // A list you wrote is the whole answer; polyphemus doesn't add to it.
    const { candidates } = fallbackCandidates(withList, resolveModel(withList, 'claude-api'), {
      isReady: () => true,
      isOut: () => false,
      knownModel: () => 'gpt-6-astra',
    });
    expect(candidates.map((c) => c.label)).toEqual(['codex', 'grok']);
  });
});
