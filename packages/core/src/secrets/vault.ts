import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PolyphemusError } from '../types.js';

// The vault: the one place polyphemus keeps secrets (docs/design/secrets.md). Everything else —
// config, memory, prompts, notes — holds only a reference like `secret:provider/anthropic`.
// Each value is encrypted on its own with AES-256-GCM, under a key file only you can read.
// This is a local backend behind a small interface; 1Password can take its place later without
// anything else changing.

export type SecretKind = 'api-key' | 'token' | 'password' | 'other';

/** Who a saved secret was kept for. Recorded so the choice isn't lost; nothing puts the value into a command until the broker exists. */
export interface SecretUse {
  who: 'agent' | 'project';
  agent?: string;
  project?: string;
}

export interface SecretMeta {
  name: string;
  kind: SecretKind;
  createdAt: number;
  updatedAt: number;
  /** What it's for, in your words. Never the value. */
  note?: string;
  /** Who it was saved for. Never the value. */
  use?: SecretUse;
}

interface StoredSecret extends Omit<SecretMeta, 'name'> {
  iv: string;
  tag: string;
  data: string;
}

interface VaultFile {
  version: 1;
  entries: Record<string, StoredSecret>;
}

export const SECRET_PREFIX = 'secret:';
/** `provider/anthropic`, `aws/acme-prod`: lowercase words, separated by / . _ - */
export const SECRET_NAME = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/;

export const isSecretRef = (text: string): boolean => text.startsWith(SECRET_PREFIX);
export const secretRef = (name: string): string => `${SECRET_PREFIX}${name}`;

/** Who asked for a secret, for the audit log: "you (terminal)", "session 3cdf80b3", "polyphemus". */
export type SecretAudit = (name: string, by: string) => void;

export class Vault {
  readonly file: string;
  readonly keyFile: string;

  constructor(
    home: string,
    private readonly opts: { audit?: SecretAudit } = {},
  ) {
    this.file = join(home, 'vault.json');
    this.keyFile = join(home, 'vault.key');
  }

  /** Every name, sorted. Names are not secret; values never leave this class except through get(). */
  names(): string[] {
    return Object.keys(this.read().entries).sort();
  }

  list(): SecretMeta[] {
    return Object.entries(this.read().entries)
      .map(([name, entry]) => ({ name, kind: entry.kind, createdAt: entry.createdAt, updatedAt: entry.updatedAt, ...(entry.note !== undefined && { note: entry.note }), ...(entry.use && { use: entry.use }) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  has(name: string): boolean {
    return this.read().entries[name] !== undefined;
  }

  /** The value, recorded in the audit log (which never holds values). Undefined if there's no such secret. */
  get(name: string, by = 'polyphemus'): string | undefined {
    const entry = this.read().entries[name];
    if (!entry) return undefined;
    this.opts.audit?.(name, by);
    return this.decrypt(name, entry);
  }

  /** `secret:aws/acme-prod` → its value. Anything else is returned as it is. */
  resolve(text: string, by = 'polyphemus'): string {
    if (!isSecretRef(text)) return text;
    const name = text.slice(SECRET_PREFIX.length);
    const value = this.get(name, by);
    if (value === undefined) throw new PolyphemusError(`There's no secret called "${name}".`, 'NOT_FOUND', 'poly secrets ls');
    return value;
  }

  set(name: string, value: string, opts: { kind?: SecretKind; note?: string; use?: SecretUse } = {}): void {
    if (!SECRET_NAME.test(name)) {
      throw new PolyphemusError(`"${name}" isn't a secret name: use lowercase words separated by / . _ or -, like provider/anthropic.`, 'USAGE');
    }
    if (!value) throw new PolyphemusError('That secret is empty.', 'USAGE');
    const file = this.read();
    const now = Date.now();
    const before = file.entries[name];
    const use = opts.use ?? before?.use;
    file.entries[name] = { ...this.encrypt(name, value), kind: opts.kind ?? before?.kind ?? 'other', note: opts.note ?? before?.note, ...(use && { use }), createdAt: before?.createdAt ?? now, updatedAt: now };
    this.write(file);
  }

  remove(name: string): boolean {
    const file = this.read();
    if (!file.entries[name]) return false;
    delete file.entries[name];
    this.write(file);
    return true;
  }

  /** Every value, so polyphemus can mask them in tool output. Not audited: nothing is being used, only hidden. */
  values(): string[] {
    return Object.entries(this.read().entries).map(([name, entry]) => this.decrypt(name, entry));
  }

  /** Mode problems with the vault's own files (it holds secrets, so only you may read them). */
  problems(): string[] {
    const out: string[] = [];
    for (const file of [this.file, this.keyFile]) {
      if (!existsSync(file)) continue;
      const mode = statSync(file).mode & 0o777;
      if (mode & 0o077) out.push(`${file} can be read by other users (mode ${mode.toString(8)}). Fix: chmod 600 ${file}`);
    }
    if (existsSync(this.file) && Object.keys(this.read().entries).length > 0 && !existsSync(this.keyFile)) {
      out.push(`${this.keyFile} is missing, so the secrets in ${this.file} can't be read. Restore it from your backup, or set them again.`);
    }
    return out;
  }

  private read(): VaultFile {
    if (!existsSync(this.file)) return { version: 1, entries: {} };
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as VaultFile;
      return { version: 1, entries: parsed.entries ?? {} };
    } catch {
      throw new PolyphemusError(`${this.file} isn't readable as a vault.`, 'FAILED', 'Restore it from your backup.');
    }
  }

  private write(file: VaultFile): void {
    mkdirSync(join(this.file, '..'), { recursive: true });
    const temp = `${this.file}.next`;
    writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, this.file);
    chmodSync(this.file, 0o600);
  }

  /** The key that encrypts every value. Made on first use; without it the vault can't be read. */
  private key(): Buffer {
    if (existsSync(this.keyFile)) {
      const key = Buffer.from(readFileSync(this.keyFile, 'utf8').trim(), 'base64');
      if (key.length !== 32) throw new PolyphemusError(`${this.keyFile} isn't a vault key.`, 'FAILED', 'Restore it from your backup.');
      return key;
    }
    if (Object.keys(this.read().entries).length > 0) {
      throw new PolyphemusError(`${this.keyFile} is missing, so the vault can't be read.`, 'FAILED', 'Restore it from your backup, or set the secrets again.');
    }
    const key = randomBytes(32);
    mkdirSync(join(this.keyFile, '..'), { recursive: true });
    writeFileSync(this.keyFile, `${key.toString('base64')}\n`, { mode: 0o600 });
    chmodSync(this.keyFile, 0o600);
    return key;
  }

  private encrypt(name: string, value: string): { iv: string; tag: string; data: string } {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key(), iv);
    // The name is bound into the ciphertext, so a value can't be moved to another name.
    cipher.setAAD(Buffer.from(name, 'utf8'));
    const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
  }

  private decrypt(name: string, entry: StoredSecret): string {
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key(), Buffer.from(entry.iv, 'base64'));
      decipher.setAAD(Buffer.from(name, 'utf8'));
      decipher.setAuthTag(Buffer.from(entry.tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(entry.data, 'base64')), decipher.final()]).toString('utf8');
    } catch (err) {
      if (err instanceof PolyphemusError) throw err;
      throw new PolyphemusError(`"${name}" couldn't be decrypted: the vault key doesn't match this vault.`, 'FAILED', 'Restore ~/.polyphemus/vault.key from your backup, or set the secret again.');
    }
  }
}
