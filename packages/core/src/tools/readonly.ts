import { cliCommand } from '../polyphemus-guide.js';
/**
 * Decides whether a shell command only reads: lists, prints, searches, counts.
 * Those run without asking. It errs toward "no": anything it can't prove is
 * read-only goes to the approval prompt as usual.
 */

const READ_ONLY_COMMANDS = new Set([
  'cat', 'head', 'tail', 'wc', 'ls', 'pwd', 'echo', 'printf', 'which', 'whereis', 'type', 'file', 'stat', 'du', 'df',
  'grep', 'egrep', 'fgrep', 'rg', 'find', 'sort', 'uniq', 'cut', 'tr', 'awk', 'sed', 'jq', 'diff', 'comm', 'basename',
  'dirname', 'realpath', 'readlink', 'date', 'id', 'whoami', 'uname', 'hostname', 'tree', 'nl', 'column', 'seq',
  'true', 'false', 'test', '[', 'cd', 'tac', 'rev', 'fold', 'md5sum', 'sha256sum', 'cksum', 'git', 'xargs',
  'journalctl',
]);
// Deliberately absent: curl and wget. They can send data anywhere (even a file's contents in a
// URL), so they always ask.

/** systemctl subcommands that only report. */
const SYSTEMCTL_READ_ONLY = new Set(['status', 'is-active', 'is-enabled', 'is-failed', 'list-units', 'list-unit-files', 'list-timers', 'show', 'cat']);

// Not fetch or anything else that writes. ls-remote only against a remote already configured
// (origin), never a URL typed into the command: a URL can carry data to any host, the way curl can
// (assessment 2026-09-12).
const GIT_READ_ONLY = new Set([
  'status', 'log', 'diff', 'show', 'ls-files', 'ls-tree', 'rev-parse', 'blame', 'grep', 'describe', 'shortlog',
  'cat-file', 'rev-list', 'reflog', 'branch', 'tag', 'remote', 'ls-remote',
]);

/** Git flags that write a file or run a program of the caller's choosing, whatever the subcommand. */
const GIT_UNSAFE_FLAG = /^(--output(=|$)|--ext-diff$|--textconv$|-O|--open-files-in-pager)/;

/** Words that shape a shell statement without running anything themselves. */
const SHELL_KEYWORDS = new Set(['do', 'done', 'then', 'fi', 'else', 'esac', '{', '}']);

export function isReadOnlyCommand(command: string): boolean {
  // Backticks, heredocs, eval, and sudo can hide anything.
  if (/`|<<|\beval\b|\bexec\b|\bsudo\b/.test(command)) return false;
  // Process substitution runs a command wherever it appears (third review, 2026-09-19).
  if (/[<>]\(/.test(command)) return false;
  // Redirects may only go to /dev/null or another stream (2>&1).
  for (const match of command.matchAll(/\d*>{1,2}\s*(&?[^\s;|&]*)/g)) {
    const target = match[1] ?? '';
    if (target !== '/dev/null' && !/^&\d$/.test(target)) return false;
  }
  // Every $(…) must be read-only too.
  let rest = command;
  for (let found = /\$\(([^()]*)\)/.exec(rest); found; found = /\$\(([^()]*)\)/.exec(rest)) {
    if (!isReadOnlyCommand(found[1] ?? '')) return false;
    // What it prints is filled in later, so it stands in as a variable: checked like one, never as a harmless word.
    rest = `${rest.slice(0, found.index)}$__${rest.slice(found.index + found[0].length)}`;
  }
  if (rest.includes('$(')) return false;
  return splitStatements(rest).every(statementIsReadOnly);
}

/**
 * Variables that may be set in front of a read-only command. Anything else can change what the
 * command does: GIT_CONFIG_* hands git any config (core.fsmonitor runs a program on `git status`),
 * PAGER and LESSOPEN name programs, LD_PRELOAD loads code (independent review, 2026-09-19).
 */
const SAFE_ASSIGNMENT = /^(LC_[A-Z]+|LANG|LANGUAGE|TZ|NO_COLOR|FORCE_COLOR|CLICOLOR|COLUMNS|LINES|TERM|GIT_PAGER=cat$|PAGER=cat$)(=|$)/;

/**
 * Commands with an option that runs a program or writes a file. Their arguments are checked as
 * written, so none may be one the shell fills in later — `$p`, a glob, an escape — whose value the
 * check never sees: `p=--pre; rg "$p" …` became `rg --pre …` (independent review, 2026-09-19). The
 * same goes for anything xargs hands them, which comes from input nobody checked.
 */
const TAKES_OPTIONS_SERIOUSLY = new Set(['git', 'rg', 'find', 'sed', 'awk', 'sort', 'uniq', 'tree', 'date', 'hostname', 'systemctl', 'journalctl', 'xargs']);

/**
 * What ripgrep may be given while still only reading: its options as of 14.1, without the ones that
 * run a program (--pre, --pre-glob, --hostname-bin, --search-zip). Kept as what's allowed, not what
 * isn't, so an option added later asks rather than slips through.
 */
const RG_OPTIONS = new Set([
  'after-context', 'auto-hybrid-regex', 'before-context', 'binary', 'block-buffered', 'byte-offset',
  'case-sensitive', 'color', 'colors', 'column', 'context', 'context-separator', 'count', 'count-matches', 'crlf',
  'debug', 'dfa-size-limit', 'encoding', 'engine', 'field-context-separator', 'field-match-separator', 'file',
  'files', 'files-with-matches', 'files-without-match', 'fixed-strings', 'follow', 'generate', 'glob',
  'glob-case-insensitive', 'heading', 'help', 'hidden', 'hyperlink-format', 'iglob', 'ignore', 'ignore-case',
  'ignore-dot', 'ignore-exclude', 'ignore-file', 'ignore-file-case-insensitive', 'ignore-files', 'ignore-global',
  'ignore-messages', 'ignore-parent', 'ignore-vcs', 'include-zero', 'invert-match', 'json', 'line-buffered',
  'line-number', 'line-regexp', 'max-columns', 'max-columns-preview', 'max-count', 'max-depth', 'max-filesize',
  'messages', 'mmap', 'multiline', 'multiline-dotall', 'no-auto-hybrid-regex', 'no-binary', 'no-block-buffered',
  'no-byte-offset', 'no-column', 'no-config', 'no-context-separator', 'no-crlf', 'no-encoding', 'no-filename',
  'no-fixed-strings', 'no-follow', 'no-glob-case-insensitive', 'no-heading', 'no-hidden', 'no-ignore',
  'no-ignore-dot', 'no-ignore-exclude', 'no-ignore-file-case-insensitive', 'no-ignore-files', 'no-ignore-global',
  'no-ignore-messages', 'no-ignore-parent', 'no-ignore-vcs', 'no-include-zero', 'no-invert-match', 'no-json',
  'no-line-buffered', 'no-line-number', 'no-max-columns-preview', 'no-messages', 'no-mmap', 'no-multiline',
  'no-multiline-dotall', 'no-one-file-system', 'no-pcre2', 'no-pcre2-unicode', 'no-pre', 'no-require-git',
  'no-search-zip', 'no-sort-files', 'no-stats', 'no-text', 'no-trim', 'no-unicode', 'null', 'null-data',
  'one-file-system', 'only-matching', 'passthru', 'path-separator', 'pcre2', 'pcre2-unicode', 'pcre2-version',
  'pretty', 'quiet', 'regexp', 'regex-size-limit', 'replace', 'require-git', 'smart-case', 'sort', 'sort-files',
  'sortr', 'stats', 'stop-on-nonmatch', 'text', 'threads', 'trace', 'trim', 'type', 'type-add', 'type-clear',
  'type-list', 'type-not', 'unicode', 'unrestricted', 'version', 'vimgrep', 'with-filename', 'word-regexp',
]);

/** Its short flags, bundled (-rn, -A3) — the same list, and never -z, which runs a decompressor. */
const RG_SHORT = /^-[AaBbCcEeFfgHhIijLlMmNnoPpqrSsTtUuVvwx0-9]+$/;

/** A shell variable an assignment on its own may set: lowercase, the scripting kind, never one the environment means something by. */
const SHELL_VARIABLE = /^[a-z_][a-z0-9_]*=/;

/**
 * Polyphemus's own CLI, reading its own settings: `help`, `capabilities`, a routine's list… Helm
 * asked the person four times to pause one routine, three of them to read (2026-09-22). Only the
 * exact launcher polyphemus hands agents (not a file of the same name a project could hold), only
 * these subcommands, every word as written, and nothing set before it but who's calling. Threads
 * (sessions show) aren't here: reading another conversation stays the person's to allow.
 */
const OWN_CLI_READS: Array<(words: string[]) => boolean> = [
  (w) => w[0] === 'help',
  (w) => w[0] === 'capabilities' && w.length === 1,
  (w) => w[0] === 'routine' && (w[1] === 'list' || w[1] === 'show') && w.length <= 3,
  (w) => w[0] === 'config' && (w[1] === 'get' || w[1] === 'history') && w.length <= 3,
  (w) => (w[0] === 'agents' || w[0] === 'skills') && (w.length === 1 || (w[1] === 'show' && w.length === 3)),
  (w) => (w[0] === 'models' || w[0] === 'projects' || w[0] === 'usage') && w.length === 1,
];

function ownCliReads(marked: Array<{ word: string; expands: boolean }>, assigned: string[]): boolean {
  const launcher = cliCommand().replace(/^node /, '');
  if (!marked.length || marked[0]!.word !== launcher || marked.some((m) => m.expands)) return false;
  if (!assigned.every((a) => /^POLYPHEMUS_CALLER=/.test(a) || SAFE_ASSIGNMENT.test(a))) return false;
  const words = marked.slice(1).map((m) => m.word).filter((w) => w !== '--json');
  if (words.some((w) => w.startsWith('-'))) return false;
  return OWN_CLI_READS.some((reads) => reads(words));
}

function statementIsReadOnly(statement: string): boolean {
  let marked = tokenizeMarked(statement);
  const assigned: string[] = [];
  while (marked.length > 0 && (SHELL_KEYWORDS.has(marked[0]!.word) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(marked[0]!.word))) {
    if (!SHELL_KEYWORDS.has(marked[0]!.word)) assigned.push(marked[0]!.word);
    marked = marked.slice(1);
  }
  const words = marked.map((m) => m.word);
  const [command, ...args] = words;
  // A statement that only sets variables runs nothing — as long as they're the script's own. PATH,
  // IFS, GIT_* and the like change what every later command does.
  if (command === undefined) return assigned.every((a) => SHELL_VARIABLE.test(a) || SAFE_ASSIGNMENT.test(a));
  if (command === 'node' && ownCliReads(marked.slice(1), assigned)) return true;
  if (!assigned.every((a) => SAFE_ASSIGNMENT.test(a))) return false;
  // Which program runs can't be left to the shell to fill in.
  if (marked[0]!.expands) return false;
  // A word can become an option if the shell fills in its start, or it starts with "-" and is filled
  // in later. A sed or awk script filled in anywhere can gain a command that writes or runs.
  // And an unquoted variable anywhere splits into words of its own: `a$x` can become `a --pre …`.
  const risky = (m: { word: string; expands: boolean; opens: boolean; splits: boolean }) => m.expands && (m.opens || m.splits || m.word.startsWith('-') || command === 'sed' || command === 'awk');
  if (TAKES_OPTIONS_SERIOUSLY.has(command) && marked.slice(1).some(risky)) return false;
  switch (command) {
    case 'for':
      return true; // the loop header; its body is checked statement by statement
    case 'if':
    case 'while':
    case 'until':
    case '!':
      return statementIsReadOnly(args.join(' '));
    case 'git':
      return gitIsReadOnly(args);
    case 'systemctl': {
      // Options (--user, --no-pager, --state=failed) around a reporting subcommand.
      const sub = args.find((a) => !a.startsWith('-'));
      return sub !== undefined && SYSTEMCTL_READ_ONLY.has(sub);
    }
    case 'journalctl':
      return !args.some((a) => /^--(rotate|vacuum|flush|sync|relinquish|setup-keys|update-catalog)/.test(a));
    case 'find':
      return !args.some((a) => /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/.test(a));
    case 'sed':
      return sedIsReadOnly(args);
    case 'awk':
      // system(), pipes, getline, and print > "file" all reach outside; -f and -i load programs.
      return !/system\s*\(|\|\s*"|getline|printf?[^;}]*>/.test(statement) && !args.some((a) => /^-(f|i|-file|-include)/.test(a));
    case 'sort':
      return !args.some((a) => /^(-o|--output|--compress-program)/.test(a) || /^-[a-zA-Z]*o/.test(a));
    case 'uniq':
      // uniq IN OUT writes OUT.
      return args.filter((a) => !a.startsWith('-')).length <= 1;
    case 'tree':
      return !args.some((a) => a === '-o' || a.startsWith('--output'));
    case 'hostname':
    case 'date':
      // Both set the thing they report when given an argument.
      return args.every((a) => a.startsWith('+') || /^-[a-zA-Z]+$/.test(a)) && !args.some((a) => /^-[a-zA-Z]*s|^--set/.test(a));
    case 'rg':
      // Only the options ripgrep is known to take without running anything: --pre runs a program on
      // every file it searches, --hostname-bin runs one to name the machine, --search-zip runs a
      // decompressor — and an option a later ripgrep adds is one this list has never heard of. So
      // anything not named here is asked about rather than assumed harmless: --hostname-bin skipped
      // the ask until 2026-09-20, when a denylist of one option was all this was.
      // After `--` everything is a pattern or a path, whatever it starts with.
      return args.slice(0, args.indexOf('--') + 1 || args.length).every((a) => !a.startsWith('-') || a === '-' || a === '--' || RG_SHORT.test(a) || RG_OPTIONS.has(a.replace(/=.*$/, '').slice(2)));
    case 'xargs': {
      const rest = withoutXargsFlags(args);
      // Whatever arrives on its input becomes arguments, unchecked: fine for cat or wc, not for a command with dangerous options.
      return rest.length > 0 && !TAKES_OPTIONS_SERIOUSLY.has(rest[0]!) && statementIsReadOnly(rest.join(' '));
    }
    default:
      return READ_ONLY_COMMANDS.has(command);
  }
}

function gitIsReadOnly(args: string[]): boolean {
  // Global options like -C <dir> or --no-pager are fine. -c and --config-env set any config for the
  // call — core.sshCommand, core.pager, a diff driver — which runs whatever program they name.
  let i = 0;
  while (i < args.length && args[i]!.startsWith('-')) {
    if (/^(-c|--config-env|--exec-path)/.test(args[i]!)) return false;
    i += args[i] === '-C' ? 2 : 1;
  }
  const sub = args[i];
  const rest = args.slice(i + 1);
  if (sub === undefined || !GIT_READ_ONLY.has(sub)) return false;
  if (rest.some((a) => GIT_UNSAFE_FLAG.test(a))) return false;
  if (sub === 'ls-remote') return rest.filter((a) => !a.startsWith('-')).every((a, i) => i > 0 || /^[\w.-]+$/.test(a)) && !rest.some((a) => a.startsWith('--upload-pack'));
  if (sub === 'reflog') return rest.length === 0 || rest[0] === 'show' || rest[0]!.startsWith('-');
  if (sub === 'branch') return rest.every((a) => /^(-a|-r|-v|-vv|--list|--all|--show-current|--contains|--merged|--no-merged)$/.test(a) || !a.startsWith('-')) && rest.filter((a) => !a.startsWith('-')).length === 0;
  if (sub === 'tag') return rest.length === 0 || rest.every((a) => a === '-l' || a === '--list' || a.startsWith('-n'));
  // Listing remotes, or one's URL. Not add/remove/set-url (they change config), and not show or
  // update, which go to the network.
  if (sub === 'remote') return rest.length === 0 || (rest.length === 1 && rest[0] === '-v') || (rest[0] === 'get-url' && rest.slice(1).every((a) => a !== 'add'));
  return true;
}

/**
 * sed only reads when every script just prints or substitutes into its output. Its w and W commands
 * (and a substitution's w flag) write files, e runs a command, and -i rewrites the input. Scripts
 * are too expressive to reason about in general, so only the plain forms pass.
 */
function sedIsReadOnly(args: string[]): boolean {
  const scripts: string[] = [];
  const files: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '-e' || a === '--expression') scripts.push(args[++i] ?? '');
    else if (a.startsWith('--expression=')) scripts.push(a.slice('--expression='.length));
    else if (a === '-f' || a.startsWith('--file') || a === '--in-place' || a.startsWith('--in-place=') || /^-[^-]*[if]/.test(a)) return false;
    else if (a.startsWith('-')) continue;
    else files.push(a);
  }
  if (scripts.length === 0 && files.length > 0) scripts.push(files.shift()!);
  const PRINT = /^(\$|\d+)?(,(\$|\d+))?[pdq=]?$/; // 1,20p · $p · 5q · 10d
  const ADDRESSED_PRINT = /^\/[^/]*\/(,\/[^/]*\/)?[pd]?$/; // /re/p · /a/,/b/p
  const SUBSTITUTE = /^(\$|\d+)?(,(\$|\d+))?s(.)(?:(?!\4).)*\4(?:(?!\4).)*\4[gIip0-9]*$/; // s/a/b/g, no w or e flag
  return scripts.every((script) => script.split(/;\s*|\n/).every((part) => {
    const command = part.trim();
    return command === '' || PRINT.test(command) || ADDRESSED_PRINT.test(command) || SUBSTITUTE.test(command);
  }));
}

function withoutXargsFlags(args: string[]): string[] {
  let i = 0;
  while (i < args.length && args[i]!.startsWith('-')) {
    const flag = args[i]!;
    i += /^-[IinPLdsE]$/.test(flag) ? 2 : 1; // flags that take a separate value
  }
  return args.slice(i);
}

/** Splits on ; && || | and newlines that aren't inside quotes. */
function splitStatements(text: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (ch === ';' || ch === '\n' || ch === '|' || (ch === '&' && text[i + 1] !== '>' && text[i - 1] !== '>' && text[i - 1] !== '<')) {
      // && and || join two statements; a lone & runs the one before in the background and starts the next.
      if ((ch === '&' && text[i + 1] === '&') || (ch === '|' && text[i + 1] === '|')) i++;
      out.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out;
}

/**
 * Splits a statement into words, and says which the shell will change before the command sees them:
 * a $ outside single quotes, a glob or brace outside quotes, a leading ~, or a backslash escape.
 */
function tokenizeMarked(text: string): Array<{ word: string; expands: boolean; opens: boolean; splits: boolean }> {
  const out: Array<{ word: string; expands: boolean; opens: boolean; splits: boolean }> = [];
  let current = '';
  let expands = false;
  // An unquoted $: its value is split into words by the shell, so it can add words of its own.
  let splits = false;
  // Whether the shell fills in the word's very first character: then nobody knows how it starts.
  let opens = false;
  let started = false;
  let quote: string | null = null;
  const filled = () => {
    if (current === '') opens = true;
    expands = true;
  };
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null;
      else {
        if (quote === '"' && (ch === '$' || ch === '\\' || ch === '`')) filled();
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) out.push({ word: current, expands, opens, splits });
      current = '';
      expands = false;
      opens = false;
      splits = false;
      started = false;
    } else {
      if (ch === '$') splits = true;
      if (/[$*?[{\\]/.test(ch) || (ch === '~' && current === '')) filled();
      current += ch;
      started = true;
    }
  }
  if (started) out.push({ word: current, expands, opens, splits });
  return out;
}

/** Splits a statement into words, honouring quotes. */
function tokenize(text: string): string[] {
  const out: string[] = [];
  let current = '';
  let started = false;
  let quote: string | null = null;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) out.push(current);
      current = '';
      started = false;
    } else {
      current += ch;
      started = true;
    }
  }
  if (started) out.push(current);
  return out;
}
