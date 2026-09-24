import type { ErrorClass } from './types.js';

// Circuit breakers (docs/design/routing.md §3): stop sending turns to a provider that keeps
// failing, then let one test turn through after a cool-down. Running out of usage isn't a
// breaker: capacity readings already hold a provider out until its reported reset.

const WINDOW_MS = 60_000;
const TRIP_AFTER = 3;
const FIRST_COOLDOWN_MS = 60_000;
const MAX_COOLDOWN_MS = 10 * 60_000;

interface Breaker {
  /** Counted failures in the last minute. */
  failures: number[];
  open: boolean;
  until: number;
  cooldown: number;
  why: string;
  /** After the cool-down, one test turn is in flight; everyone else waits for its result. */
  probing: boolean;
}

const clockTime = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

export class Breakers {
  private readonly breakers = new Map<string, Breaker>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Why a provider shouldn't get a turn right now ("is paused: …"), or undefined when it can. */
  blocked(provider: string): string | undefined {
    const b = this.breakers.get(provider);
    if (!b?.open) return undefined;
    if (this.now() < b.until) return `is paused: ${b.why} (polyphemus tries it again at ${clockTime(b.until)})`;
    return b.probing ? `is paused: ${b.why} (checking it with one turn now)` : undefined;
  }

  /** A turn is starting on this provider; after a cool-down, that turn is the test. */
  attempt(provider: string): void {
    const b = this.breakers.get(provider);
    if (b?.open && this.now() >= b.until) b.probing = true;
  }

  succeeded(provider: string): void {
    this.breakers.delete(provider);
  }

  /** You chose this provider yourself: let it try again. */
  clear(provider: string): void {
    this.breakers.delete(provider);
  }

  /** Counts a failure. Returns what to tell the user when this trips the breaker. */
  failed(provider: string, errorClass: ErrorClass, message: string): string | undefined {
    const now = this.now();
    const b = this.breakers.get(provider) ?? { failures: [], open: false, until: 0, cooldown: 0, why: '', probing: false };
    const trip = (why: string, cooldown: number) => {
      this.breakers.set(provider, { failures: [], open: true, until: now + cooldown, cooldown, why, probing: false });
      return this.blocked(provider);
    };
    // What to do comes with it: a pause that only says when it ends leaves someone waiting on a login
    // that won't fix itself (2026-09-23).
    if (errorClass === 'auth') return trip(`its login was rejected (${message.slice(0, 120)}). Sign in again, or check its key, in Setup → Models & providers`, MAX_COOLDOWN_MS);
    if (errorClass === 'rate_limited') return trip('it is rate limiting requests', FIRST_COOLDOWN_MS);
    // Out of usage is tracked by capacity; bad requests and oversized context aren't the provider's fault.
    if (errorClass !== 'overloaded' && errorClass !== 'unknown') return undefined;
    // The test turn after a cool-down failed too: wait twice as long before the next one.
    if (b.open && b.probing) return trip(b.why, Math.min(b.cooldown * 2, MAX_COOLDOWN_MS));
    if (b.open) return undefined; // turns already in flight when it tripped
    b.failures = [...b.failures.filter((t) => now - t < WINDOW_MS), now];
    this.breakers.set(provider, b);
    return b.failures.length >= TRIP_AFTER ? trip(`${TRIP_AFTER} failures in a minute`, FIRST_COOLDOWN_MS) : undefined;
  }
}
