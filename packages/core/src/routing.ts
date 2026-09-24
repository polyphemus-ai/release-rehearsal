import { isMetered, offList, resolveModel, type Config, type ResolvedModel } from './config.js';
import { readingExpired } from './quota.js';
import { ProviderError, type CapacityReading, type ErrorClass } from './types.js';

/** Failures another model can route around. Auth errors and bad requests stop instead (docs/design/routing.md). */
const FALLBACK_CLASSES: ReadonlySet<ErrorClass> = new Set(['rate_limited', 'quota_exhausted', 'overloaded']);

export function canFallBack(err: unknown): err is ProviderError {
  return err instanceof ProviderError && FALLBACK_CLASSES.has(err.errorClass);
}

/**
 * The reading that says a provider can't take work right now: out of quota, or a window at 100%.
 * Not once its reset has come, or, for a quota error that gave no reset, once the retry time has.
 */
export function outReading(readings: readonly CapacityReading[] | undefined, now = Date.now()): CapacityReading | undefined {
  return readings?.find((r) => (r.window === 'quota' || (r.usedPct ?? 0) >= 100) && !readingExpired(r, now));
}

export interface CandidateOptions {
  isReady(provider: string): boolean;
  isOut(provider: string): boolean;
  /** Providers already tried for this turn. */
  tried?: ReadonlySet<string>;
  /**
   * A model id known to work on a provider nothing is named for — the last one actually used.
   * Without it, a provider you're signed in to is invisible to fallback until you name an alias.
   */
  knownModel?(provider: string): string | undefined;
}

/**
 * Where a turn can go when `current` can't take it, in order.
 *
 * With a fallback list (the model's own, else `[routing].fallback`), only those
 * models are candidates, and `explicit` is true. With no list, every other ready
 * alias is offered, but `explicit` is false: those are only suggestions, used
 * when the user is asked, never switched to automatically.
 */
export function fallbackCandidates(
  config: Config,
  current: ResolvedModel,
  opts: CandidateOptions,
): { candidates: ResolvedModel[]; explicit: boolean; skippedMetered: ResolvedModel[] } {
  const chain = current.fallback ?? config.routing.fallback;
  const explicit = chain.length > 0;
  const seen = new Set<string>();
  const candidates: ResolvedModel[] = [];
  // Leaving a plan for a per-token bill needs your say-so (routing.allow_metered). Already on an API
  // key, you're already paying that way, so moving between them isn't a new kind of cost.
  const blocksMetered = !config.routing.allowMetered && !isMetered(config, current.provider);
  const skippedMetered: ResolvedModel[] = [];
  // The pool with no explicit chain: models you chose, plus any short names you've defined.
  for (const ref of explicit ? chain : [...config.selected, ...Object.keys(config.models)]) {
    let model: ResolvedModel;
    try {
      model = resolveModel(config, ref);
    } catch {
      continue;
    }
    const target = `${model.provider}:${model.model}`;
    if (seen.has(target) || model.provider === current.provider || opts.tried?.has(model.provider)) continue;
    // A fallback is still something running: only onto a model on your list.
    if (offList(config, model)) continue;
    seen.add(target);
    if (!opts.isReady(model.provider) || opts.isOut(model.provider)) continue;
    if (blocksMetered && isMetered(config, model.provider)) skippedMetered.push(model);
    else candidates.push(model);
  }
  // Then providers you can use that nothing is named on. Being unnamed is a gap in your config,
  // not a reason to be stranded when the model you were using runs out. Only without an explicit
  // chain: a chain you wrote is the whole answer.
  if (!explicit) {
    for (const [id, provider] of Object.entries(config.providers)) {
      if (id === current.provider || opts.tried?.has(id)) continue;
      if (!opts.isReady(id) || opts.isOut(id)) continue;
      if (blocksMetered && isMetered(config, id)) continue;
      // A vendor CLI picks its own model. For an API provider we only offer an id we've seen
      // work, because a guessed one fails at the moment you most need it not to.
      const model = provider.auth.type === 'cli' ? 'default' : opts.knownModel?.(id);
      if (!model || offList(config, { provider: id, model })) continue;
      const target = `${id}:${model}`;
      if (seen.has(target)) continue;
      seen.add(target);
      candidates.push({ label: target, provider: id, model });
    }
  }
  return { candidates, explicit, skippedMetered };
}
