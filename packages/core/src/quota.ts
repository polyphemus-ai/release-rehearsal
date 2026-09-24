import type { CapacityReading } from './types.js';

/**
 * How long a quota error that didn't say when it resets keeps a provider out. Without a limit, one
 * "usage balance exhausted" was remembered for days while the account had long since recovered and
 * every turn quietly went elsewhere. An hour is long enough not to hammer a provider that really is
 * empty (one failed turn an hour, and only when there's work for it), and short enough that a
 * topped-up balance or a limit that lifted on its own gets used again the same session. Polyphemus
 * doesn't probe (docs/design/capacity.md): after this, the next real turn meant for it is the test.
 */
export const QUOTA_RETRY_MS = 60 * 60_000;

// The owner can change it (routing.quota_retry_minutes); set from config when it loads.
let retryMs = QUOTA_RETRY_MS;

/** How long a quota error with no reset keeps a provider out, as configured. */
export const quotaRetryMs = (): number => retryMs;

export function setQuotaRetryMinutes(minutes: number | undefined): void {
  retryMs = minutes === undefined ? QUOTA_RETRY_MS : minutes * 60_000;
}

/** When a reading stops saying a provider is out: its reset, or for a bare quota error, an hour after it. */
export function readingEndsAt(reading: CapacityReading): Date | undefined {
  if (reading.resetsAt) return reading.resetsAt;
  if (reading.window === 'quota' && reading.observedAt) return new Date(reading.observedAt.getTime() + retryMs);
  return undefined;
}

/** A reading whose reset (or retry time) has come has nothing more to say. */
export function readingExpired(reading: CapacityReading, now = Date.now()): boolean {
  const ends = readingEndsAt(reading);
  return ends !== undefined && ends.getTime() <= now;
}

/**
 * A reset time a provider put in its error text ("try again in 2 hours 5 minutes", "resets in 30m").
 * Only relative forms: an absolute time in someone else's words and time zone is easy to misread.
 */
export function resetFromMessage(message: string, now = Date.now()): Date | undefined {
  const phrase = /(?:try again|resets?|available again|retry)\s+in\s+((?:\d+\s*(?:days?|hours?|hrs?|minutes?|mins?|d|h|m)\b(?:\s*,?\s*(?:and\s+)?)?)+)/i.exec(message)?.[1];
  if (!phrase) return undefined;
  let ms = 0;
  for (const [, n, unit] of phrase.matchAll(/(\d+)\s*(d|h|m)/gi)) ms += Number(n) * { d: 86_400_000, h: 3_600_000, m: 60_000 }[unit!.toLowerCase() as 'd' | 'h' | 'm'];
  return ms > 0 ? new Date(now + ms) : undefined;
}
