import { describe, expect, it } from 'vitest';
import { readsOnly } from '../src/connections/scope.js';

// A read is pre-ticked when granting and runs without asking, so what counts as one matters. Polyphemus's
// own servers are trusted to say; anyone else's label has to agree with the tool's name (2026-09-28).
describe('which tools only read', () => {
  const theirs = (name: string, annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean }) => readsOnly({ name, annotations }, { trusted: false });

  it('takes another server’s word only when the name agrees', () => {
    // Marked read-only, but named for what it changes: a change, asked about and not pre-ticked.
    expect(theirs('send_email', { readOnlyHint: true })).toBe(false);
    expect(theirs('create_issue', { readOnlyHint: true })).toBe(false);
    expect(theirs('search_and_delete', { readOnlyHint: true })).toBe(false);
    expect(theirs('notion-update-page', { readOnlyHint: true })).toBe(false);
    // A read by label and by name, however the name is written.
    expect(theirs('notion-search', { readOnlyHint: true })).toBe(true);
    expect(theirs('get_issue', { readOnlyHint: true })).toBe(true);
    expect(theirs('listPullRequests', { readOnlyHint: true })).toBe(true);
    expect(theirs('notion-download-attachment', { readOnlyHint: true })).toBe(true);
    // No label at all: the name decides, as before.
    expect(theirs('get_issue')).toBe(true);
    expect(theirs('frobnicate')).toBe(false);
    // A read-looking name never beats a label that says it changes things.
    expect(theirs('get_and_reset', { readOnlyHint: false })).toBe(false);
    expect(theirs('get_contacts', { destructiveHint: true })).toBe(false);
    expect(theirs('get_contacts', { readOnlyHint: false })).toBe(false);
  });

  it('trusts polyphemus’s own servers to say what their code does', () => {
    expect(readsOnly({ name: 'download_file', annotations: { readOnlyHint: true } })).toBe(true);
    expect(readsOnly({ name: 'frobnicate', annotations: { readOnlyHint: true } })).toBe(true);
    expect(readsOnly({ name: 'get_contacts', annotations: { readOnlyHint: false } })).toBe(false);
  });
});
