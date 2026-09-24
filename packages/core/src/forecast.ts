import { formatWhen } from './format.js';
import type { CapacityReading } from './types.js';

// Capacity forecasts (docs/design/capacity.md): not "how much is used" but "will it last until it
// resets?". Pace compares use with time: at 1.0x a window runs out exactly at its reset. The
// run-out time comes from the recent burn rate when there's history, else the pace so far.

const RECENT_MS = 60 * 60_000;
const MIN_SPAN_MS = 10 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const WATCH_PCT = 75;

export interface Forecast {
  provider: string;
  window: string;
  usedPct: number;
  resetsAt?: number;
  /** Used ÷ share of the window gone by: 1.0 = on track to run out exactly at the reset. */
  pace?: number;
  /** Percent per hour, from the last hour of readings, else the average this window. */
  ratePerHour?: number;
  basis?: 'recent' | 'window';
  /** When it runs out at this rate, if that's before the reset. */
  runsOutAt?: number;
  /** When the provider last told us this. A reading is only as fresh as the last turn on it. */
  observedAt: number;
  /**
   * No evidence for the current pace: nothing has run on this provider for a while, so `usedPct`
   * is the last thing it said rather than what's true now. A stale reading never projects a
   * run-out — the old code averaged across the whole window and warned from a day-old number.
   */
  stale: boolean;
  /** out: used up · short: runs out before it resets · watch: 75% or more · ok. */
  status: 'out' | 'short' | 'watch' | 'ok';
}

/** "5h" → 5 hours in ms. Undefined for windows without a fixed length ("quota"). */
export function windowLength(window: string): number | undefined {
  const match = /^(\d+)\s*(m|h|d|w)$/.exec(window);
  if (!match) return undefined;
  return Number(match[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[match[2] as 'm' | 'h' | 'd' | 'w'];
}

export function forecast(
  provider: string,
  reading: CapacityReading,
  samples: ReadonlyArray<{ usedPct: number; observedAt: number; resetsAt?: number }>,
  now = Date.now(),
): Forecast {
  const usedPct = reading.usedPct ?? 0;
  const resetsAt = reading.resetsAt?.getTime();
  // No observedAt means the provider didn't say when, so there's nothing to call stale.
  const observedAt = reading.observedAt?.getTime() ?? now;
  // A provider only reports its usage when a turn runs on it, so a reading goes stale on its own.
  const stale = now - observedAt > RECENT_MS;
  const base: Forecast = {
    provider,
    window: reading.window,
    usedPct,
    observedAt,
    stale,
    ...(resetsAt !== undefined && { resetsAt }),
    status: usedPct >= WATCH_PCT ? 'watch' : 'ok',
  };
  if (usedPct >= 100) return { ...base, status: 'out' };
  // Without recent readings there's no pace to report: the average across the window would put a
  // day-old number on a "runs out in two hours" warning, which is how this went wrong.
  if (stale) return base;

  const length = windowLength(reading.window);
  const start = resetsAt !== undefined && length !== undefined ? resetsAt - length : undefined;
  const elapsed = start !== undefined ? now - start : undefined;
  const pace = elapsed !== undefined && length !== undefined && elapsed > length * 0.02 ? usedPct / 100 / (elapsed / length) : undefined;

  // The last hour of readings from this same window (same reset time), oldest first.
  const recent = samples
    .filter((s) => now - s.observedAt <= RECENT_MS && (resetsAt === undefined || s.resetsAt === undefined || s.resetsAt === resetsAt))
    .sort((a, b) => a.observedAt - b.observedAt);
  const first = recent[0];
  const span = first ? now - first.observedAt : 0;
  let ratePerHour: number | undefined;
  let basis: Forecast['basis'];
  // A window of days is used in bursts, around sleep and work: one busy hour said a weekly window
  // would run out tomorrow. Its pace is the average since it reset.
  const long = length !== undefined && length > DAY_MS;
  if (first && span >= MIN_SPAN_MS && !long) {
    ratePerHour = Math.max(0, ((usedPct - first.usedPct) / span) * 3_600_000);
    basis = 'recent';
  } else if (elapsed !== undefined && elapsed > 0) {
    ratePerHour = (usedPct / elapsed) * 3_600_000;
    basis = 'window';
  }

  const result: Forecast = { ...base, ...(pace !== undefined && { pace }), ...(ratePerHour !== undefined && { ratePerHour, basis }) };
  // Too early to tell from the window's average: fifteen minutes after a weekly reset, 1% used read
  // as "runs out tomorrow" (2026-09-21). A tenth of a long window, a twentieth of a short one.
  const early = basis === 'window' && elapsed !== undefined && length !== undefined && elapsed < length * (long ? 0.1 : 0.05);
  if (ratePerHour && ratePerHour > 0 && resetsAt !== undefined && !early) {
    const runsOutAt = now + ((100 - usedPct) / ratePerHour) * 3_600_000;
    if (runsOutAt < resetsAt) return { ...result, runsOutAt, status: 'short' };
  }
  return result;
}

/** "at this pace it runs out Thu 3:10 PM, before it resets Mon 7:00 PM", or "on pace to last until it resets". */
export function describeForecast(f: Forecast): string {
  if (f.status === 'out') return `used up${f.resetsAt ? `, back ${formatWhen(new Date(f.resetsAt))}` : ''}`;
  if (f.stale) return `${Math.round(f.usedPct)}% as of ${formatWhen(new Date(f.observedAt))} — nothing has run on it since`;
  if (f.status === 'short' && f.runsOutAt) return `at this pace it runs out ${formatWhen(new Date(f.runsOutAt))}, before it resets${f.resetsAt ? ` ${formatWhen(new Date(f.resetsAt))}` : ''}`;
  if (f.pace !== undefined) return `on pace to last until it resets (pace ${f.pace.toFixed(1)}x)`;
  if (f.ratePerHour !== undefined) return 'on pace to last until it resets';
  return 'no forecast yet';
}
