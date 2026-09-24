import type { ResolvedModel } from './config.js';
import { readingEndsAt } from './quota.js';
import type { CapacityReading } from './types.js';

/** A reading older than this is shown with "as of …". */
export const STALE_USAGE_MS = 15 * 60 * 1000;

/** "just now", "5m ago", "3h ago", "2d ago". */
export function ago(timestamp: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** "11:10 PM", or "Mon 8:23 PM" when it's more than most of a day away. */
export function formatWhen(at: Date): string {
  const time = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return at.getTime() - Date.now() > 20 * 3600 * 1000 ? `${at.toLocaleDateString([], { weekday: 'short' })} ${time}` : time;
}

/**
 * Why a provider is out after a quota error, and when that ends: "said it was out of quota at 12:40 PM;
 * polyphemus tries it again after 1:40 PM", or "is out of quota until Mon 8:23 PM" when it said.
 */
export function describeQuota(reading: CapacityReading): string {
  if (reading.resetsAt) return `is out of quota until ${formatWhen(reading.resetsAt)}`;
  const at = reading.observedAt ? ` at ${formatAt(reading.observedAt)}` : '';
  const retry = readingEndsAt(reading);
  return `said it was out of quota${at}${retry ? `; polyphemus tries it again after ${formatWhen(retry)}` : ''}`;
}

/** "12:40 PM" today, else "Mon 12:40 PM". */
function formatAt(at: Date): string {
  const time = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return at.toDateString() === new Date().toDateString() ? time : `${at.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}

/** "7d 98% (resets Mon 8:23 PM)", or "out of quota (tries again after 1:40 PM)". For people. */
export function formatUsage(reading: CapacityReading): string {
  if (reading.window === 'quota') {
    if (reading.resetsAt) return `out of quota (resets ${formatWhen(reading.resetsAt)})`;
    const retry = readingEndsAt(reading);
    return retry ? `out of quota (tries again after ${formatWhen(retry)})` : 'out of quota';
  }
  const resets = reading.resetsAt ? ` (resets ${formatWhen(reading.resetsAt)})` : '';
  return `${reading.window} ${Math.round(reading.usedPct ?? 0)}%${resets}`;
}

/** "7d window 98% used (2% left), resets Mon 8:23 PM". For models: spelled out so it can't be misread. */
export function describeLeft(reading: CapacityReading): string {
  if (reading.window === 'quota') return describeQuota(reading);
  const used = Math.round(reading.usedPct ?? 0);
  return `${reading.window} window ${used}% used (${Math.max(0, 100 - used)}% left)${reading.resetsAt ? `, resets ${formatWhen(reading.resetsAt)}` : ''}`;
}

/** " (as of 3h ago)" when the newest information about a provider is old. */
export function staleNote(readings: readonly CapacityReading[]): string {
  const oldest = Math.min(...readings.map((r) => r.observedAt?.getTime() ?? Date.now()));
  return Date.now() - oldest > STALE_USAGE_MS ? ` (as of ${ago(oldest)})` : '';
}

/** "codex 7d 98% (resets Mon 8:23 PM) · grok-build out of quota (as of 3h ago)". */
export function usageSummary(capacity: ReadonlyMap<string, readonly CapacityReading[]>): string {
  return [...capacity.entries()]
    .map(([provider, readings]) => `${provider} ${readings.map(formatUsage).join(', ')}${staleNote(readings)}`)
    .join(' · ');
}

/** "claude (claude-code:default)", or just "anthropic:claude-opus-5" when there's no alias. */
export function describeModel(model: ResolvedModel): string {
  const target = `${model.provider}:${model.model}`;
  return model.label === target ? target : `${model.label} (${target})`;
}
