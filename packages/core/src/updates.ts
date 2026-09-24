import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assetPath, bundled } from './assets.js';
import type { UpdateChannel } from './config.js';

// Is there a newer polyphemus? An installed polyphemus asks npm once a day — the request carries nothing
// about you or this computer, and `updates.check = false` stops it. A copy run from the repository
// never asks: it's updated with git, and its version number isn't a published one.

const DAY = 24 * 60 * 60 * 1000;
const registry = () => (process.env.POLYPHEMUS_NPM_REGISTRY ?? 'https://registry.npmjs.org').replace(/\/$/, '');

export interface UpdateStatus {
  current: string;
  /** Which releases this install follows. */
  channel: UpdateChannel;
  /** How this copy is updated: an npm package, or a checkout of the repository. */
  installedFrom: 'npm' | 'checkout';
  latest: string | null;
  newer: boolean;
  checkedAt: number | null;
  /** Why there's no answer, when there isn't one. */
  why?: string;
}

export const currentVersion = (): string => (JSON.parse(readFileSync(assetPath('cli', 'package.json'), 'utf8')) as { version: string }).version;

/** -1, 0 or 1: semantic versions, where a prerelease comes before its release. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre] = v.replace(/^v/, '').split('-', 2);
    return { nums: (core ?? '').split('.').map((n) => Number.parseInt(n, 10) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) if ((x.nums[i] ?? 0) !== (y.nums[i] ?? 0)) return (x.nums[i] ?? 0) < (y.nums[i] ?? 0) ? -1 : 1;
  if (x.pre === y.pre) return 0;
  if (x.pre === undefined) return 1;
  if (y.pre === undefined) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/** What's known, without asking anyone: the last answer, from the cache, if it was for this channel. */
export function knownUpdate(home: string, opts: { current?: string; installedFrom?: 'npm' | 'checkout'; channel?: UpdateChannel } = {}): UpdateStatus {
  const current = opts.current ?? currentVersion();
  const installedFrom = opts.installedFrom ?? (bundled ? 'npm' : 'checkout');
  const channel = opts.channel ?? 'stable';
  try {
    const cached = JSON.parse(readFileSync(join(home, 'update-check.json'), 'utf8')) as { latest: string; checkedAt: number; channel?: UpdateChannel };
    if ((cached.channel ?? 'stable') !== channel) throw new Error('another channel');
    return { current, channel, installedFrom, latest: cached.latest, newer: installedFrom === 'npm' && compareVersions(current, cached.latest) < 0, checkedAt: cached.checkedAt };
  } catch {
    return { current, channel, installedFrom, latest: null, newer: false, checkedAt: null };
  }
}

/**
 * The newest release a channel offers, from npm's tags: stable follows `latest`; beta follows
 * `next`, or `latest` when a stable release has overtaken the last beta.
 */
export function newestOn(channel: UpdateChannel, tags: Record<string, unknown>): string | undefined {
  const valid = (v: unknown): v is string => typeof v === 'string' && /^\d+\.\d+\.\d+/.test(v);
  const stable = valid(tags.latest) ? tags.latest : undefined;
  if (channel === 'stable') return stable;
  const beta = valid(tags.next) ? tags.next : undefined;
  if (!beta) return stable;
  if (!stable) return beta;
  return compareVersions(beta, stable) > 0 ? beta : stable;
}

/** Asks npm, if it's been a day (or `force`) and checking is on. Never throws: a failed check is just no news. */
export async function checkForUpdate(home: string, opts: { enabled: boolean; force?: boolean; now?: number; current?: string; installedFrom?: 'npm' | 'checkout'; channel?: UpdateChannel } = { enabled: true }): Promise<UpdateStatus> {
  const known = knownUpdate(home, opts);
  if (known.installedFrom === 'checkout') return { ...known, why: 'Run from a checkout: it’s updated with git.' };
  if (!opts.enabled) return { ...known, why: 'Checking is off (updates.check = false).' };
  const now = opts.now ?? Date.now();
  if (!opts.force && known.checkedAt && now - known.checkedAt < DAY) return known;
  try {
    const res = await fetch(`${registry()}/-/package/polyphemus/dist-tags`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { ...known, why: `npm answered ${res.status}` };
    const latest = newestOn(known.channel, (await res.json()) as Record<string, unknown>);
    if (!latest) return { ...known, why: 'npm didn’t say a version' };
    writeFileSync(join(home, 'update-check.json'), `${JSON.stringify({ latest, checkedAt: now, channel: known.channel })}\n`, { mode: 0o600 });
    return { ...known, latest, checkedAt: now, newer: compareVersions(known.current, latest) < 0 };
  } catch (err) {
    return { ...known, why: `Couldn’t reach npm: ${(err as Error).message}` };
  }
}
