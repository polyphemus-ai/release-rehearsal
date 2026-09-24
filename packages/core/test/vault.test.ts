import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Credentials, credentialPathFor, makeRedactor, secretRef, Vault } from '../src/index.js';

const newHome = () => mkdtempSync(join(tmpdir(), 'polyphemus-vault-'));

describe('the vault', () => {
  it('keeps secrets encrypted, hands them back by name, and records every use', () => {
    const home = newHome();
    const used: Array<{ name: string; by: string }> = [];
    const vault = new Vault(home, { audit: (name, by) => used.push({ name, by }) });

    vault.set('aws/acme-prod', 'AKIA-not-a-real-key', { kind: 'api-key', note: 'Acme deploy' });
    expect(vault.get('aws/acme-prod', 'you (terminal)')).toBe('AKIA-not-a-real-key');
    expect(used).toEqual([{ name: 'aws/acme-prod', by: 'you (terminal)' }]);
    expect(vault.list()).toEqual([expect.objectContaining({ name: 'aws/acme-prod', kind: 'api-key', note: 'Acme deploy' })]);
    vault.set('aws/acme-prod', 'AKIA-not-a-real-key', { use: { who: 'agent', agent: 'helper' } });
    expect(vault.list()[0]).toMatchObject({ use: { who: 'agent', agent: 'helper' } });
    expect(JSON.stringify(vault.list())).not.toContain('AKIA-not-a-real-key');

    // The value is nowhere in the file, and only you can read it (or its key).
    const onDisk = readFileSync(vault.file, 'utf8');
    expect(onDisk).not.toContain('AKIA-not-a-real-key');
    expect(onDisk).toContain('aws/acme-prod');
    expect(statSync(vault.file).mode & 0o077).toBe(0);
    expect(statSync(vault.keyFile).mode & 0o077).toBe(0);
    expect(vault.problems()).toEqual([]);

    // A reference is what everything else holds.
    expect(vault.resolve(secretRef('aws/acme-prod'))).toBe('AKIA-not-a-real-key');
    expect(vault.resolve('plain text')).toBe('plain text');
    expect(() => vault.resolve('secret:nope')).toThrow('There’s no secret called "nope".'.replace('’', "'"));

    expect(vault.remove('aws/acme-prod')).toBe(true);
    expect(vault.remove('aws/acme-prod')).toBe(false);
    expect(vault.names()).toEqual([]);
  });

  it('refuses bad names, empty values, and a value moved to another name', () => {
    const home = newHome();
    const vault = new Vault(home);
    expect(() => vault.set('AWS Prod', 'x')).toThrow("isn't a secret name");
    expect(() => vault.set('aws/prod', '')).toThrow('empty');

    vault.set('one', 'first');
    vault.set('two', 'second');
    // Swapping the stored entries doesn't swap the secrets: each is sealed to its own name.
    const file = JSON.parse(readFileSync(vault.file, 'utf8')) as { entries: Record<string, unknown> };
    [file.entries.one, file.entries.two] = [file.entries.two, file.entries.one];
    writeFileSync(vault.file, JSON.stringify(file));
    expect(() => vault.get('one')).toThrow("the vault key doesn't match");
  });

  it('says what’s wrong when the key is missing or the files are readable', () => {
    const home = newHome();
    const vault = new Vault(home);
    vault.set('a/b', 'value');
    chmodSync(vault.file, 0o644);
    expect(vault.problems()[0]).toContain('can be read by other users');

    const orphan = new Vault(newHome());
    orphan.set('a/b', 'value');
    writeFileSync(orphan.keyFile, 'not-a-key');
    expect(() => orphan.get('a/b')).toThrow("isn't a vault key");
  });

  it('is where tools may never look, and everything in it is masked in tool output', () => {
    const home = newHome();
    const vault = new Vault(home);
    vault.set('provider/anthropic', 'sk-ant-supersecretvalue-1234567890');
    const credentials = new Credentials(join(home, 'credentials.json'), vault);

    expect(credentialPathFor(vault.file, home)).toBeUndefined(); // guarded by ~/.polyphemus path, checked below
    expect(credentialPathFor(join(home, '.polyphemus/vault.key'), home)).toBe(join(home, '.polyphemus/vault.key'));
    expect(makeRedactor(credentials.allApiKeys())('key is sk-ant-supersecretvalue-1234567890')).toBe('key is «redacted secret»');
  });

  it('masks a secret kept inside a record, not only the whole record', () => {
    // A sign-in or a linked bank is one JSON record in the vault. What a service hands back is the
    // token on its own, so masking only the whole record missed it (connections review, 2026-09-20).
    const record = JSON.stringify({ itemToken: 'access-sandbox-9f8e7d6c5b4a3210', nested: { refresh: 'refresh-0123456789abcdef' }, kind: 'plaid' });
    const redact = makeRedactor([record]);

    expect(redact('used access-sandbox-9f8e7d6c5b4a3210 to read it')).toBe('used «redacted secret» to read it');
    expect(redact('and refresh-0123456789abcdef after that')).toBe('and «redacted secret» after that');
    expect(redact(`the whole thing: ${record}`)).toContain('«redacted secret»');
    // Short values inside a record aren't secrets, and masking them would eat ordinary words.
    expect(redact('the kind is plaid')).toBe('the kind is plaid');
  });
});

describe('provider keys', () => {
  it('move out of plain text into the vault, and are read from there', () => {
    const home = newHome();
    const legacy = join(home, 'credentials.json');
    writeFileSync(legacy, JSON.stringify({ anthropic: { apiKey: 'sk-ant-old-key-value' }, openai: { apiKey: 'sk-old-openai-value' } }), { mode: 0o600 });
    const vault = new Vault(home);
    const credentials = new Credentials(legacy, vault);

    expect(credentials.legacyProviders()).toEqual(['anthropic', 'openai']);
    expect(credentials.apiKey('anthropic')).toBe('sk-ant-old-key-value'); // still works before migrating

    expect(credentials.migrate()).toEqual(['anthropic', 'openai']);
    expect(existsSync(legacy)).toBe(false); // nothing left in plain text
    expect(credentials.legacyProviders()).toEqual([]);
    expect(vault.names()).toEqual(['provider/anthropic', 'provider/openai']);
    expect(credentials.apiKey('anthropic')).toBe('sk-ant-old-key-value');

    credentials.setApiKey('anthropic', 'sk-ant-new-key-value');
    expect(vault.get('provider/anthropic')).toBe('sk-ant-new-key-value');
    credentials.deleteApiKey('anthropic');
    expect(credentials.apiKey('anthropic')).toBeUndefined();
  });
});
