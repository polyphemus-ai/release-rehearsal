import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { parse } from 'smol-toml';
import { configFile, parseConfig } from './config.js';
import type { ConfigRevision, SessionStore } from './session/store.js';
import { PolyphemusError } from './types.js';

// Changing config.toml safely (docs/design/cli-for-agents.md §4): every change is validated
// against the whole config, written atomically, and recorded as a numbered revision you can undo.
// Edits touch only the lines they change, so comments survive. Edits made outside polyphemus are
// noticed, and changes wait until you adopt or undo them.

export const configHash = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16);

/** A value typed on the command line: TOML when it reads as TOML (true, 3, ["a", "b"]), else a string. */
export function parseValue(raw: string): unknown {
  try {
    return (parse(`v = ${raw}`) as { v: unknown }).v;
  } catch {
    return raw;
  }
}

const BARE_KEY = /^[A-Za-z0-9_-]+$/;
const keyText = (key: string) => (BARE_KEY.test(key) ? key : JSON.stringify(key));
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function literal(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map(literal).join(', ')}]`;
  if (value && typeof value === 'object') return `{ ${Object.entries(value).map(([k, v]) => `${keyText(k)} = ${literal(v)}`).join(', ')} }`;
  throw new PolyphemusError(`Can't write ${String(value)} as a setting.`, 'USAGE');
}

const withoutStringsAndComments = (line: string) => line.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""').replace(/#.*$/, '');
const depthOf = (line: string) => {
  const bare = withoutStringsAndComments(line);
  return (bare.match(/[[{]/g)?.length ?? 0) - (bare.match(/[\]}]/g)?.length ?? 0);
};

/** The lines of a [section] (header index, and where it ends); '' is the top level before any section. */
function sectionRange(lines: string[], section: string): { header: number; end: number } | undefined {
  const isHeader = (line: string) => /^\s*\[/.test(line);
  if (section === '') {
    const first = lines.findIndex(isHeader);
    return { header: -1, end: first === -1 ? lines.length : first };
  }
  const header = lines.findIndex((line) => {
    const match = /^\s*\[\s*([^\]]+?)\s*\]\s*(#.*)?$/.exec(line);
    if (!match || line.trim().startsWith('[[')) return false;
    const name = match[1]!.split('.').map((part) => part.trim().replace(/^"(.*)"$/, '$1')).join('.');
    return name === section;
  });
  if (header === -1) return undefined;
  let end = lines.length;
  for (let i = header + 1; i < lines.length; i++) {
    if (isHeader(lines[i]!)) {
      end = i;
      break;
    }
  }
  return { header, end };
}

/** Where a key's value sits, over as many lines as it takes (a multi-line array, say). */
function findKey(lines: string[], range: { header: number; end: number }, key: string): { start: number; end: number } | undefined {
  const pattern = new RegExp(`^\\s*${escapeRegExp(keyText(key))}\\s*=`);
  for (let i = range.header + 1; i < range.end; i++) {
    if (!pattern.test(lines[i]!)) continue;
    let depth = depthOf(lines[i]!.slice(lines[i]!.indexOf('=') + 1));
    let j = i;
    while (depth > 0 && j + 1 < range.end) {
      j += 1;
      depth += depthOf(lines[j]!);
    }
    return { start: i, end: j + 1 };
  }
  return undefined;
}

/**
 * Sets (or, with `value` undefined, removes) one dotted setting, touching only its own lines.
 * Throws a PolyphemusError that says what to do instead when it can't.
 */
export function editConfig(text: string, key: string, value: unknown): string {
  const parts = key.split('.').filter(Boolean);
  if (parts.length === 0) throw new PolyphemusError('Which setting? Use a dotted name, like routing.fallback.', 'USAGE');
  const name = parts.at(-1)!;
  const section = parts.slice(0, -1).join('.');
  const lines = text.split('\n');
  const line = value === undefined ? undefined : `${keyText(name)} = ${literal(value)}`;
  const range = sectionRange(lines, section);

  // A table-valued setting may already live as its own section: [models.grok] rather than a
  // grok = { … } line inside [models]. Writing the inline form beside the section is a TOML
  // conflict ("trying to redefine an already defined table"), which is how a perfectly good
  // config edit came back as an invalid document.
  const own = sectionRange(lines, key);
  if (own && isTable(value)) {
    const body = Object.entries(value as Record<string, unknown>).map(([k, v]) => `${keyText(k)} = ${literal(v)}`);
    lines.splice(own.header + 1, own.end - own.header - 1, ...body);
    return lines.join('\n');
  }
  if (own && value === undefined) {
    // Remove the whole section, and the blank line it left behind.
    let from = own.header;
    while (from > 0 && lines[from - 1]!.trim() === '') from -= 1;
    lines.splice(from, own.end - from);
    return lines.join('\n');
  }

  if (!range) {
    // A setting inside an inline table (auth = { type = …, env = … }) can't be edited line by line.
    if (parts.length >= 3) {
      const parent = sectionRange(lines, parts.slice(0, -2).join('.'));
      const holder = parent && findKey(lines, parent, parts.at(-2)!);
      if (holder && /=\s*\{/.test(lines[holder.start]!)) {
        throw new PolyphemusError(`${parts.slice(0, -1).join('.')} is written inline ({ … }), so set it whole: poly config set ${parts.slice(0, -1).join('.')} '{ … }'`, 'USAGE');
      }
    }
    if (line === undefined) throw new PolyphemusError(`There's no setting ${key} to remove.`, 'NOT_FOUND', 'poly config get');
    // A table gets its own section. Sibling sections ([models.claude] and friends) already use
    // that shape, and an inline value next to them wouldn't parse.
    if (isTable(value)) {
      const body = Object.entries(value as Record<string, unknown>).map(([k, v]) => `${keyText(k)} = ${literal(v)}`);
      return `${text.replace(/\n*$/, '\n')}\n[${key}]\n${body.join('\n')}\n`;
    }
    return `${text.replace(/\n*$/, '\n')}\n[${section}]\n${line}\n`;
  }

  const found = findKey(lines, range, name);
  if (found) {
    if (line === undefined) lines.splice(found.start, found.end - found.start);
    else lines.splice(found.start, found.end - found.start, line);
    return lines.join('\n');
  }
  if (line === undefined) throw new PolyphemusError(`There's no setting ${key} to remove.`, 'NOT_FOUND', 'poly config get');
  // A commented-out example of the setting (# default_model = "claude") becomes the real one.
  const example = new RegExp(`^\\s*#\\s*${escapeRegExp(keyText(name))}\\s*=`);
  for (let i = range.header + 1; i < range.end; i++) {
    if (example.test(lines[i]!)) {
      lines[i] = line;
      return lines.join('\n');
    }
  }
  // Otherwise after the section's last setting (or at the top, for a top-level setting with none).
  let at = range.header + 1;
  for (let i = range.header + 1; i < range.end; i++) if (/^\s*[^#\s]/.test(lines[i]!)) at = i + 1;
  lines.splice(at, 0, line);
  return lines.join('\n');
}

/** A plain object, which TOML can write either inline or as its own [section]. */
const isTable = (value: unknown): boolean => typeof value === 'object' && value !== null && !Array.isArray(value);

/** One setting's value (a whole table for a section, everything with no key). */
export function getConfigValue(text: string, key?: string): unknown {
  let value: unknown = parse(text);
  for (const part of key ? key.split('.').filter(Boolean) : []) {
    if (!value || typeof value !== 'object' || !(part in value)) throw new PolyphemusError(`There's no setting ${key}.`, 'NOT_FOUND', 'poly config get');
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

/** "- old line" / "+ new line" with a line of context around each change; empty when nothing changed. */
export function lineDiff(before: string, after: string, context = 1): string[] {
  const a = before.split('\n');
  const b = after.split('\n');
  const common: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) common[i]![j] = a[i] === b[j] ? common[i + 1]![j + 1]! + 1 : Math.max(common[i + 1]![j]!, common[i]![j + 1]!);
  }
  const ops: Array<[' ' | '-' | '+', string]> = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) ops.push([' ', a[i++]!]), j++;
    else if (common[i + 1]![j]! >= common[i]![j + 1]!) ops.push(['-', a[i++]!]);
    else ops.push(['+', b[j++]!]);
  }
  while (i < a.length) ops.push(['-', a[i++]!]);
  while (j < b.length) ops.push(['+', b[j++]!]);
  if (!ops.some(([kind]) => kind !== ' ')) return [];
  const near = (k: number) => ops.slice(Math.max(0, k - context), k + context + 1).some(([kind]) => kind !== ' ');
  const out: string[] = [];
  let skipping = false;
  ops.forEach(([kind, text], k) => {
    if (kind !== ' ' || near(k)) {
      out.push(`${kind} ${text}`);
      skipping = false;
    } else if (!skipping) {
      out.push('  …');
      skipping = true;
    }
  });
  return out;
}

function validate(text: string, file: string): void {
  try {
    parseConfig(text, file);
  } catch (err) {
    throw new PolyphemusError(`${(err as Error).message}. Nothing was changed.`, 'USAGE');
  }
}

/** config.toml, with its numbered history. `caller` is who's making changes ("you (terminal)", "an agent"). */
export class ConfigHistory {
  readonly file: string;

  constructor(
    home: string,
    private readonly store: SessionStore,
    private readonly caller: string,
  ) {
    this.file = configFile(home);
  }

  read(): string {
    return existsSync(this.file) ? readFileSync(this.file, 'utf8') : '';
  }

  latest(): ConfigRevision | undefined {
    return this.store.configRevisions(1)[0];
  }

  /** The last recorded revision, if the file has changed outside polyphemus since. The first look records it. */
  drift(): ConfigRevision | undefined {
    const text = this.read();
    const last = this.latest();
    if (!last) {
      this.recordCurrent('recorded as it was');
      return undefined;
    }
    return configHash(text) === last.hash ? undefined : last;
  }

  /** What a change would do, validated against the whole config. Nothing is written. */
  plan(key: string, value: unknown): { before: string; after: string } {
    const before = this.read();
    const after = editConfig(before, key, value);
    validate(after, this.file);
    return { before, after };
  }

  /** Writes `after` atomically and records it. Refuses while an outside edit is unrecorded, unless `force`. */
  apply(after: string, action: string, force = false): number {
    if (!force && this.drift()) {
      throw new PolyphemusError('config.toml was edited outside polyphemus since its last recorded change.', 'CONFLICT', 'poly config diff, then poly config adopt (keep it) or poly config undo (go back)');
    }
    validate(after, this.file);
    const temp = `${this.file}.next`;
    writeFileSync(temp, after);
    renameSync(temp, this.file);
    return this.record(action, after);
  }

  /** Keeps an edit made outside polyphemus: validates it and records it as a revision. */
  adopt(): number {
    const text = this.read();
    validate(text, this.file);
    if (!this.drift()) throw new PolyphemusError('config.toml matches its last recorded revision: there’s nothing to adopt.', 'CONFLICT');
    return this.record('adopted an edit made outside polyphemus', text);
  }

  /** Goes back one change: drops an unrecorded outside edit, or else returns to the revision before the last. */
  undo(): number {
    const [last, previous] = this.store.configRevisions(2);
    if (!last) throw new PolyphemusError('There’s no history yet.', 'NOT_FOUND');
    if (this.drift()) return this.apply(last.content, `undid an edit made outside polyphemus (back to r${last.rev})`, true);
    if (!previous) throw new PolyphemusError('Nothing to undo: this is the first recorded revision.', 'NOT_FOUND', 'poly config history');
    return this.apply(previous.content, `undid r${last.rev} (${last.action})`, true);
  }

  rollback(rev: number): number {
    const target = this.store.configRevision(rev);
    if (!target) throw new PolyphemusError(`There's no revision ${rev}.`, 'NOT_FOUND', 'poly config history');
    return this.apply(target.content, `rolled back to r${rev}`, true);
  }

  /** Records the file as it is now (for writes polyphemus makes itself, like remembering a default model). */
  recordCurrent(action: string): number {
    return this.record(action, this.read());
  }

  private record(action: string, content: string): number {
    return this.store.addConfigRevision({ caller: this.caller, action, content, hash: configHash(content) });
  }
}
