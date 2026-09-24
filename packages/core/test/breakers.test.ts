import { describe, expect, it } from 'vitest';
import { Breakers } from '../src/breakers.js';

describe('circuit breakers', () => {
  it('rests a provider after 3 failures in a minute, then lets one test turn through', () => {
    let now = 1_000_000;
    const breakers = new Breakers(() => now);
    expect(breakers.failed('codex', 'overloaded', 'busy')).toBeUndefined();
    now += 10_000;
    expect(breakers.failed('codex', 'unknown', 'socket hang up')).toBeUndefined();
    now += 10_000;
    expect(breakers.failed('codex', 'overloaded', 'busy')).toMatch(/^is paused: 3 failures in a minute \(polyphemus tries it again at /);
    expect(breakers.blocked('codex')).toContain('3 failures in a minute');

    // After the cool-down, one turn is the test; others wait for its result.
    now += 60_000;
    expect(breakers.blocked('codex')).toBeUndefined();
    breakers.attempt('codex');
    expect(breakers.blocked('codex')).toContain('checking it with one turn now');
    // The test failed: the next rest is twice as long.
    expect(breakers.failed('codex', 'overloaded', 'busy')).toContain('is paused');
    now += 60_000;
    expect(breakers.blocked('codex')).toContain('is paused');
    now += 60_000;
    expect(breakers.blocked('codex')).toBeUndefined();
    breakers.attempt('codex');
    breakers.succeeded('codex');
    expect(breakers.blocked('codex')).toBeUndefined();
  });

  it('forgets failures older than a minute, and ignores ones another model wouldn’t fix', () => {
    let now = 0;
    const breakers = new Breakers(() => now);
    breakers.failed('xai', 'overloaded', 'busy');
    breakers.failed('xai', 'overloaded', 'busy');
    now += 61_000;
    expect(breakers.failed('xai', 'overloaded', 'busy')).toBeUndefined();
    expect(breakers.failed('xai', 'invalid_request', 'bad tool schema')).toBeUndefined();
    expect(breakers.failed('xai', 'context_exceeded', 'too long')).toBeUndefined();
    expect(breakers.failed('xai', 'quota_exhausted', 'out of credits')).toBeUndefined();
    expect(breakers.blocked('xai')).toBeUndefined();
  });

  it('rests at once on a rejected login or rate limiting, and a deliberate choice clears it', () => {
    const breakers = new Breakers(() => 0);
    expect(breakers.failed('anthropic', 'auth', 'invalid x-api-key')).toContain('its login was rejected (invalid x-api-key)');
    expect(breakers.failed('openai', 'rate_limited', '429')).toContain('rate limiting');
    breakers.clear('anthropic');
    expect(breakers.blocked('anthropic')).toBeUndefined();
    expect(breakers.blocked('openai')).toContain('is paused');
  });
});
