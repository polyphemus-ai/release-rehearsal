import { describe, expect, it } from 'vitest';
import { sameSite } from '../src/connections-api.js';

// A sign-in card is answered by the sign-in the person actually kept, and can always be cleared.
describe('which sign-in answers which card', () => {
  it('takes the site the person ended on, and nothing wider', () => {
    // Withings sent the person from account.withings.com to app.withings.com, and the card asking for
    // the first stayed open with no way to clear it (2026-09-22).
    expect(sameSite('account.withings.com', 'app.withings.com')).toBe(true);
    expect(sameSite('account.withings.com', 'account.withings.com')).toBe(true);
    expect(sameSite('ACCOUNT.Withings.com', 'app.withings.com')).toBe(true);
    expect(sameSite('withings.com', 'app.withings.com')).toBe(true);
    expect(sameSite('127.0.0.1', '127.0.0.1')).toBe(true);
    // Another site is another site, however much of the name it shares.
    expect(sameSite('account.withings.com', 'withings.com.evil.test')).toBe(false);
    expect(sameSite('sso.garmin.com', 'app.withings.com')).toBe(false);
    expect(sameSite('account.withings.com', '')).toBe(false);
    expect(sameSite('', '')).toBe(false);
    // Names registered under a country's domain, sites on shared hosting, and IP addresses: two
    // labels alone made each of these pairs the same site (security review, 2026-09-24).
    expect(sameSite('mybank.co.uk', 'evil.co.uk')).toBe(false);
    expect(sameSite('login.mybank.co.uk', 'www.mybank.co.uk')).toBe(true);
    expect(sameSite('alice.github.io', 'mallory.github.io')).toBe(false);
    expect(sameSite('alice.github.io', 'alice.github.io')).toBe(true);
    expect(sameSite('127.0.0.1', '10.66.0.1')).toBe(false);
    expect(sameSite('shop.example.com.au', 'evil.com.au')).toBe(false);
  });
});
