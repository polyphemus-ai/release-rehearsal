import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CapacityReading } from '../types.js';

// SuperGrok's plan usage, from xAI. The Grok CLI has no command that says how much of the plan is
// left (`grok usage` is one session's tokens), so polyphemus asks the billing endpoint the CLI's own
// backend serves, with the sign-in the CLI already holds — the way OpenClaw does (2026-09-16).
//
// This is the one exception to "never lift a vendor's subscription tokens" (AGENTS.md), and it's
// kept narrow on purpose: one read-only GET for the usage figure, the token read from the CLI's file
// when it's needed and never stored, copied, refreshed or used for anything else. An expired sign-in
// isn't renewed here — the CLI renews it on its next turn — and any failure is "unknown", never a guess.
// The endpoint isn't a documented API, so it can change without notice.

export const GROK_BILLING_URL = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits';

interface GrokAuthEntry {
  key?: unknown;
  auth_mode?: unknown;
  expires_at?: unknown;
  create_time?: unknown;
}

export interface GrokUsageDeps {
  /** Where the Grok CLI keeps its files: GROK_HOME, else ~/.grok. */
  home?: string;
  fetch?: typeof fetch;
  now?: number;
}

export interface GrokUsage {
  readings: CapacityReading[];
  observedAt?: Date;
  /** Why there's no reading, in words, when there isn't one. */
  unknown?: string;
}

/** The CLI's current sign-in token, if it has one that hasn't run out. Never logged, never kept. */
async function currentToken(home: string, now: number): Promise<string | undefined | 'expired'> {
  let entries: GrokAuthEntry[];
  try {
    entries = Object.values(JSON.parse(await readFile(join(home, 'auth.json'), 'utf8')) as Record<string, GrokAuthEntry>);
  } catch {
    return undefined;
  }
  const signedIn = entries
    .filter((e) => typeof e.key === 'string' && e.key.length > 0)
    .sort((a, b) => Date.parse(String(b.create_time ?? '')) - Date.parse(String(a.create_time ?? '')));
  if (signedIn.length === 0) return undefined;
  const fresh = signedIn.find((e) => {
    const expires = Date.parse(String(e.expires_at ?? ''));
    return !Number.isFinite(expires) || expires - now > 60_000;
  });
  return fresh ? (fresh.key as string) : 'expired';
}

/** xAI's answer as a reading: its percent used this period, and when the period ends. */
export function parseGrokBilling(body: unknown, now = new Date()): CapacityReading[] {
  const config = (body as { config?: Record<string, unknown> } | null)?.config;
  if (!config || typeof config !== 'object') return [];
  const pct = config.creditUsagePercent ?? config.credit_usage_percent;
  if (typeof pct !== 'number' || !Number.isFinite(pct) || pct < 0) return [];
  const period = (config.currentPeriod ?? config.current_period) as { type?: unknown; end?: unknown } | undefined;
  const type = typeof period?.type === 'string' ? period.type : '';
  // Polyphemus's own names, so a reading from here lines up with the rest.
  const window = type.endsWith('WEEKLY') ? '7d' : type.endsWith('MONTHLY') ? 'month' : 'plan';
  const end = Date.parse(String(period?.end ?? config.billingPeriodEnd ?? ''));
  return [{ window, usedPct: Math.min(100, pct), observedAt: now, ...(Number.isFinite(end) && { resetsAt: new Date(end) }) }];
}

export async function readGrokUsage(deps: GrokUsageDeps = {}): Promise<GrokUsage> {
  const now = deps.now ?? Date.now();
  const home = deps.home ?? process.env.GROK_HOME ?? join(homedir(), '.grok');
  const token = await currentToken(home, now);
  if (token === undefined) return { readings: [], unknown: 'the Grok CLI isn’t signed in' };
  if (token === 'expired') return { readings: [], unknown: 'the Grok CLI’s sign-in has run out; its next turn renews it' };
  let response: Response;
  try {
    response = await (deps.fetch ?? fetch)(GROK_BILLING_URL, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'x-grok-client-mode': 'cli', 'x-grok-client-version': '1.0.25' },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return { readings: [], unknown: 'xAI’s billing endpoint couldn’t be reached' };
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return { readings: [], unknown: `xAI’s billing endpoint answered ${response.status}` };
  }
  const readings = parseGrokBilling(await response.json().catch(() => null), new Date(now));
  return readings.length ? { readings, observedAt: new Date(now) } : { readings: [], unknown: 'xAI’s billing endpoint didn’t say how much is used' };
}
