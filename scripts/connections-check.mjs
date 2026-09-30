#!/usr/bin/env node
// Whether every service in the connections catalogue that signs in with OAuth still lets polyphemus
// sign in (docs/design/plugins.md): its published sign-in rules — protected-resource and
// authorization-server metadata — and a registration endpoint for apps it hasn't met. Read-only: no
// app is registered and nobody signs in. A last step needs an account, and is a person's to try.
//
//   node scripts/connections-check.mjs            # every OAuth entry
//   node scripts/connections-check.mjs trello ahrefs
import { createRequire } from 'node:module';

const require = createRequire(new URL('../packages/cli/package.json', import.meta.url));
const { tsImport } = await import(require.resolve('tsx/esm/api'));
const { CONNECTION_CATALOGUE } = await tsImport('../packages/core/src/connections/catalogue.ts', import.meta.url);
const { discoverOAuth } = await tsImport('../packages/core/src/connections/oauth.ts', import.meta.url);

const only = process.argv.slice(2);
const entries = CONNECTION_CATALOGUE.filter((e) => e.signIn === 'oauth' && e.url && (!only.length || only.includes(e.id)));
const results = await Promise.all(
  entries.map(async (e) => {
    try {
      // The same discovery a sign-in does, stopping before it registers anything.
      const found = await Promise.race([discoverOAuth(e.url), new Promise((_, reject) => setTimeout(() => reject(new Error('no answer in 20s')), 20_000))]);
      if (!found) return { e, ok: false, said: 'publishes no OAuth sign-in' };
      if (!found.registrationEndpoint && !found.client) return { e, ok: false, said: 'takes only apps its vendor approved' };
      return { e, ok: true, said: `signs in at ${new URL(found.authorizationEndpoint).host}` };
    } catch (err) {
      return { e, ok: false, said: err.message.split('\n')[0].slice(0, 120) };
    }
  }),
);
const width = Math.max(...results.map((r) => r.e.id.length));
for (const r of results.sort((a, b) => Number(a.ok) - Number(b.ok) || a.e.id.localeCompare(b.e.id))) console.log(`${r.ok ? '✓' : '✗'} ${r.e.id.padEnd(width)}  ${r.said}`);
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} of ${results.length} would let polyphemus sign in.`);
process.exit(failed.length ? 1 : 0);
