import { describe, expect, it } from 'vitest';
import { describeForecast, forecast, windowLength } from '../src/forecast.js';
import { parseClaudeUsage } from '../src/agents/claude-cli.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const now = Date.parse('2026-09-11T20:00:00Z');

describe('capacity forecasts', () => {
  it('knows how long windows are', () => {
    expect(windowLength('5h')).toBe(5 * HOUR);
    expect(windowLength('7d')).toBe(7 * DAY);
    expect(windowLength('quota')).toBeUndefined();
  });

  it('warns when the pace so far runs out before the reset', () => {
    // One day into a weekly window, already 28% used: about 2x pace.
    const f = forecast('claude-code', { window: '7d', usedPct: 28, resetsAt: new Date(now + 6 * DAY) }, [], now);
    expect(f.status).toBe('short');
    expect(f.pace).toBeCloseTo(1.96, 1);
    expect(f.basis).toBe('window');
    expect(f.runsOutAt).toBeCloseTo(now + (72 / (28 / 24)) * HOUR, -4);
    expect(describeForecast(f)).toMatch(/^at this pace it runs out .*, before it resets /);
  });

  it('says it will last when the pace is under 1x', () => {
    const f = forecast('codex', { window: '7d', usedPct: 20, resetsAt: new Date(now + 4 * DAY) }, [], now);
    expect(f).toMatchObject({ status: 'ok', basis: 'window' });
    expect(f.runsOutAt).toBeUndefined();
    expect(describeForecast(f)).toBe('on pace to last until it resets (pace 0.5x)');
  });

  it('uses the last hour when there is one: busy now can be short, quiet now can last', () => {
    const resetsAt = now + 3 * HOUR;
    const reading = { window: '5h', usedPct: 50, resetsAt: new Date(resetsAt) };
    const busy = forecast('claude-code', reading, [{ usedPct: 30, observedAt: now - 30 * 60_000, resetsAt }], now);
    expect(busy).toMatchObject({ basis: 'recent', status: 'short' });
    expect(busy.ratePerHour).toBeCloseTo(40);
    const quiet = forecast('claude-code', reading, [{ usedPct: 50, observedAt: now - 40 * 60_000, resetsAt }], now);
    expect(quiet).toMatchObject({ basis: 'recent', status: 'ok', ratePerHour: 0 });
    // Readings from the previous window (a different reset time) don't count.
    const stale = forecast('claude-code', reading, [{ usedPct: 95, observedAt: now - 30 * 60_000, resetsAt: now - HOUR }], now);
    expect(stale.basis).toBe('window');
  });

  it('says nothing about running out when it’s too early to tell, or from one busy hour of a week', () => {
    // Fifteen minutes after a weekly reset, 1% used: "runs out tomorrow" (2026-09-21).
    const justReset = forecast('claude-code', { window: '7d', usedPct: 1, resetsAt: new Date(now + 7 * DAY - 15 * 60_000) }, [], now);
    expect(justReset.status).toBe('ok');
    expect(justReset.runsOutAt).toBeUndefined();
    // Two days in, a busy last hour doesn't decide a weekly window: the average since the reset does.
    const resetsAt = now + 5 * DAY;
    const week = forecast('claude-code', { window: '7d', usedPct: 20, resetsAt: new Date(resetsAt) }, [{ usedPct: 15, observedAt: now - 40 * 60_000, resetsAt }], now);
    expect(week).toMatchObject({ basis: 'window', status: 'ok' });
  });

  it('marks used-up and nearly used-up windows', () => {
    expect(forecast('codex', { window: '7d', usedPct: 100, resetsAt: new Date(now + DAY) }, [], now).status).toBe('out');
    expect(forecast('codex', { window: '7d', usedPct: 80, resetsAt: new Date(now + HOUR) }, [], now).status).toBe('watch');
  });

  it('will not forecast from a reading nothing has refreshed', () => {
    // What went wrong for real: codex's reading was 37 hours old at 98%, and the forecast
    // averaged it across the whole window to warn "runs out in two hours", over and over.
    const now = Date.parse('2026-09-12T15:00:00Z');
    const stale = forecast(
      'codex',
      { window: '7d', usedPct: 98, resetsAt: new Date('2026-09-15T01:23:39Z'), observedAt: new Date('2026-09-11T01:25:59Z') },
      [],
      now,
    );
    expect(stale.stale).toBe(true);
    expect(stale.status).not.toBe('short');
    expect(stale.runsOutAt).toBeUndefined();
    expect(describeForecast(stale)).toContain('nothing has run on it since');

    // The same numbers, observed just now, still warn.
    const fresh = forecast(
      'codex',
      { window: '7d', usedPct: 98, resetsAt: new Date('2026-09-15T01:23:39Z'), observedAt: new Date(now - 60_000) },
      [],
      now,
    );
    expect(fresh.stale).toBe(false);
    expect(fresh.status).toBe('short');
  });
});

describe('reading Claude Code’s own /usage', () => {
  const now = new Date('2026-09-12T15:30:00Z');
  const output = [
    'You are currently using your subscription to power your Claude Code usage',
    '',
    'Current session: 3% used · resets Sep 12, 1:10pm (America/Chicago)',
    'Current week (all models): 34% used · resets Sep 14, 7pm (America/Chicago)',
    'Current week (Fable): 0% used · resets Sep 14, 7pm (America/Chicago)',
    '',
    "What's contributing to your limits usage?",
    'Last 24h · 1074 requests · 20 sessions',
    '  93% of your usage was at >150k context',
    '  Top skills: /artifact-design 2%',
  ].join('\n');

  it('takes the windows and leaves the prose alone', () => {
    const readings = parseClaudeUsage(output, now);
    // The two polyphemus already knows keep their names, so a polled reading replaces a streamed one.
    expect(readings.map((r) => r.window)).toEqual(['5h', '7d', 'week (Fable)']);
    expect(readings.map((r) => r.usedPct)).toEqual([3, 34, 0]);
    // "93% of your usage was at >150k context" is prose with a percent in it, not a window.
    expect(readings.some((r) => r.usedPct === 93)).toBe(false);
  });

  it('reads the reset times, and keeps them in the future', () => {
    const [session, week] = parseClaudeUsage(output, now);
    expect(session!.resetsAt!.getTime()).toBeGreaterThan(now.getTime());
    expect(week!.resetsAt!.getTime()).toBeGreaterThan(session!.resetsAt!.getTime());
    // A December reading read in January belongs to next year, not ten months ago.
    const [rolled] = parseClaudeUsage('Current session: 5% used · resets Dec 31, 9pm (UTC)', new Date('2027-01-02T00:00:00Z'));
    expect(rolled!.resetsAt!.getFullYear()).toBe(2027);
  });

  it('gives nothing rather than guessing when the shape changes', () => {
    expect(parseClaudeUsage('')).toEqual([]);
    expect(parseClaudeUsage('Some new wording entirely.')).toEqual([]);
  });
});

