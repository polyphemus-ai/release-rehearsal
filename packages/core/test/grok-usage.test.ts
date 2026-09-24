import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GROK_BILLING_URL, parseGrokBilling, readGrokUsage } from '../src/agents/grok-usage.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { Polyphemus } from '../src/polyphemus.js';

// What xAI's billing endpoint answered for a SuperGrok account on 2026-09-16 (values changed).
const BILLING = {
  config: {
    currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', start: '2026-09-14T00:21:45.080116+00:00', end: '2026-09-21T00:21:45.080116+00:00' },
    creditUsagePercent: 2,
    onDemandCap: { val: 0 },
    onDemandUsed: { val: 0 },
    productUsage: [],
    isUnifiedBillingUser: true,
    prepaidBalance: { val: 0 },
    billingPeriodStart: '2026-09-14T00:21:45Z',
    billingPeriodEnd: '2026-09-21T00:21:45Z',
  },
};
const TOKEN = 'grok-cli-sign-in-token-that-stays-with-the-cli';

async function grokHome(entry: Record<string, unknown> | null): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'polyphemus-grok-home-'));
  if (entry) await writeFile(join(home, 'auth.json'), JSON.stringify({ 'https://auth.x.ai::client': { auth_mode: 'oidc', create_time: '2026-09-16T17:30:09Z', refresh_token: 'never-used', ...entry } }));
  return home;
}

const later = (ms: number) => new Date(Date.now() + ms).toISOString();

describe('SuperGrok usage from xAI', () => {
  it('reads the week’s percent used and when it resets', () => {
    expect(parseGrokBilling(BILLING)).toEqual([{ window: '7d', usedPct: 2, resetsAt: new Date('2026-09-21T00:21:45.080116+00:00'), observedAt: expect.any(Date) }]);
    expect(parseGrokBilling({ config: { ...BILLING.config, currentPeriod: { type: 'USAGE_PERIOD_TYPE_MONTHLY', end: '2026-10-01T00:00:00Z' } } })[0]).toMatchObject({ window: 'month' });
    expect(parseGrokBilling({ config: {} })).toEqual([]);
    expect(parseGrokBilling(null)).toEqual([]);
  });

  it('asks only the billing endpoint, with the CLI’s current sign-in, and nothing else', async () => {
    const asked: Array<{ url: string; auth: string | null; method: string }> = [];
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      asked.push({ url, auth: new Headers(init?.headers).get('authorization'), method: init?.method ?? 'GET' });
      return new Response(JSON.stringify(BILLING), { status: 200 });
    }) as typeof fetch;
    const usage = await readGrokUsage({ home: await grokHome({ key: TOKEN, expires_at: later(3_600_000) }), fetch: fakeFetch });
    expect(usage.readings).toMatchObject([{ window: '7d', usedPct: 2 }]);
    expect(usage.observedAt).toBeInstanceOf(Date);
    expect(asked).toEqual([{ url: GROK_BILLING_URL, auth: `Bearer ${TOKEN}`, method: 'GET' }]);
    expect(JSON.stringify(usage)).not.toContain(TOKEN);
  });

  it('says why it doesn’t know, and never renews a sign-in or guesses', async () => {
    const neverCalled = (async () => {
      throw new Error('should not be asked');
    }) as typeof fetch;
    expect(await readGrokUsage({ home: await grokHome(null), fetch: neverCalled })).toEqual({ readings: [], unknown: 'the Grok CLI isn’t signed in' });
    expect(await readGrokUsage({ home: await grokHome({ key: TOKEN, expires_at: later(-60_000) }), fetch: neverCalled })).toEqual({ readings: [], unknown: 'the Grok CLI’s sign-in has run out; its next turn renews it' });
    const refused = (async () => new Response('no', { status: 401 })) as typeof fetch;
    expect(await readGrokUsage({ home: await grokHome({ key: TOKEN, expires_at: later(3_600_000) }), fetch: refused })).toEqual({ readings: [], unknown: 'xAI’s billing endpoint answered 401' });
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    expect((await readGrokUsage({ home: await grokHome({ key: TOKEN, expires_at: later(3_600_000) }), fetch: down })).unknown).toBe('xAI’s billing endpoint couldn’t be reached');
  });

  it('ends an earlier quota error when xAI says there’s room', async () => {
    const home = await mkdtemp(join(tmpdir(), 'polyphemus-grok-usage-'));
    await writeFile(join(home, 'config.toml'), DEFAULT_CONFIG.replace(/^selected = .*$/m, 'selected = ["grok-build:grok-4.6"]'));
    process.env.CODEX_HOME = join(home, 'no-codex');
    process.env.GROK_HOME = join(home, 'no-grok');
    const polyphemus = await Polyphemus.open(home);
    // Signed in to Grok; nothing else is, so nothing else is asked.
    const status = polyphemus.status.bind(polyphemus);
    polyphemus.status = (provider) => (provider === 'grok-build' ? { ready: true, note: '' } : { ...status(provider), ready: false });
    polyphemus.recordUsage('grok-build', [{ window: 'quota', usedPct: 100 }]);
    expect(polyphemus.outReading('grok-build')).toMatchObject({ window: 'quota' });

    polyphemus.grokUsage = async () => ({ readings: [{ window: '7d', usedPct: 100 }], observedAt: new Date() });
    await polyphemus.refreshCliUsage({ ask: true });
    expect(polyphemus.outReading('grok-build')).toBeDefined();

    polyphemus.grokUsage = async () => ({ readings: [{ window: '7d', usedPct: 2 }], observedAt: new Date() });
    await polyphemus.refreshCliUsage({ ask: true });
    expect(polyphemus.outReading('grok-build')).toBeUndefined();
    expect(polyphemus.capacity.get('grok-build')).toMatchObject([{ window: '7d', usedPct: 2 }]);

    // Not asked on the quiet refresh at startup, only when polyphemus looks on purpose.
    let asked = 0;
    polyphemus.grokUsage = async () => (asked++, { readings: [] });
    await polyphemus.refreshCliUsage();
    expect(asked).toBe(0);
    polyphemus.close?.();
  });
});
