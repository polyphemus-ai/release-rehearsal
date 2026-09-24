import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, normalize, resolve, sep } from 'node:path';

/**
 * Files and folders that hold credentials. Polyphemus tools refuse to read or write
 * them, whatever the model asks (docs/design/secrets.md). This is a guard that
 * reduces exposure, not a sandbox: a process running as you can still reach
 * anything you can, and text checks can be talked around. Real isolation is its
 * own milestone (roadmap.md).
 */
const CREDENTIAL_PATHS = [
  '.claude/.credentials.json',
  '.codex/auth.json',
  '.grok/auth.json',
  '.polyphemus/credentials.json',
  '.polyphemus/vault.json', // the vault itself, and the key that opens it
  '.polyphemus/vault.key',
  '.polyphemus/daemon-token', // the terminal's key to the daemon: with it, anything could answer approvals
  '.polyphemus/github-apps',
  // Copies of the vault and its key: an update's backups, and the copy a self-check works on
  // (security review, 2026-09-24 — they were outside this list, and readable without asking).
  '.polyphemus/backups',
  '.polyphemus/self-check',
  '.ssh',
  '.aws/credentials',
  '.aws/sso/cache',
  '.secrets',
  '.config/gh/hosts.yml',
  '.netrc',
  '.docker/config.json',
  '.openclaw/gateway.env',
  '.openclaw/credentials',
  // Ordinary stores on a developer's machine, which the first list didn't know about
  // (connections review, 2026-09-20).
  '.git-credentials',
  '.config/git/credentials',
  '.config/gcloud/application_default_credentials.json',
  '.config/gcloud/credentials.db',
  '.config/gcloud/legacy_credentials',
  '.kube/config',
  '.npmrc',
  '.yarnrc.yml',
  '.pypirc',
  '.gnupg',
  '.password-store',
  '.config/hub',
  '.cargo/credentials.toml',
  '.terraform.d/credentials.tfrc.json',
];

/** Polyphemus's own secrets, wherever POLYPHEMUS_HOME puts them. */
const POLYPHEMUS_SECRETS = ['credentials.json', 'vault.json', 'vault.key', 'daemon-token', 'github-apps', 'backups', 'self-check'];

const credentialPaths = (home: string): string[] => {
  const polyphemusHome = process.env.POLYPHEMUS_HOME;
  return [
    ...CREDENTIAL_PATHS.map((path) => resolve(home, path)),
    ...(polyphemusHome ? POLYPHEMUS_SECRETS.map((name) => resolve(polyphemusHome, name)) : []),
  ];
};

/** A project's .env files hold its keys. The committed templates (.env.example) don't. */
const isEnvFile = (path: string): boolean => /^\.env(\..+)?$/.test(basename(path)) && !/\.(example|sample|template|dist)$/.test(path);

/** Where a path really points: through symlinks, as far as the path exists. */
function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    // Not there yet (a file about to be written): resolve the folder it would go in.
    const parent = dirname(path);
    return parent === path ? path : resolve(realPath(parent), basename(path));
  }
}

/**
 * The credential store an absolute path falls inside, if any — checked as written and as it resolves,
 * against each store as written and as it resolves. A path resolves to where a file really is, so a
 * store reached through a link (a home under /var, which macOS links to /private/var, or a
 * ~/.polyphemus that's a link to another disk) has to be known by its real path too, or a link to it
 * gets through (2026-09-23). It's named as written.
 */
export function credentialPathFor(path: string, home = homedir()): string | undefined {
  const guarded = storesAsResolved(home);
  for (const candidate of new Set([normalize(path), realPath(path)])) {
    const hit = guarded.find(([g]) => candidate === g || candidate.startsWith(g + sep));
    if (hit) return hit[1];
    if (isEnvFile(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Each store as written and as it resolves, worked out once a minute rather than on every check: the
 * guard runs on every file a tool touches, and resolving a path under an automounted folder (macOS's
 * /home) can take seconds (2026-09-23). A store moved behind a link is seen as moved within the minute.
 */
const resolved = new Map<string, { at: number; stores: ReadonlyArray<readonly [string, string]> }>();
function storesAsResolved(home: string): ReadonlyArray<readonly [string, string]> {
  const written = credentialPaths(home);
  const key = written.join('\0');
  const kept = resolved.get(key);
  if (kept && Date.now() - kept.at < 60_000) return kept.stores;
  const stores = written.flatMap((store) => [[store, store], [realPath(store), store]] as const);
  resolved.set(key, { at: Date.now(), stores });
  return stores;
}

/**
 * A credential store a shell command mentions, if any: as ~/…, $HOME/…, an absolute path, or a
 * relative one (`cd ~ && cat .codex/auth.json`), with ./ and ../ and doubled slashes read the way
 * the shell would. It's a text check, so it can't see through variables or globs it isn't told
 * about — which is why a command that merely looks harmless still isn't allowed to skip approval
 * when it touches these paths.
 */
export function credentialReferenceIn(command: string, home = homedir()): string | undefined {
  const expanded = command.replace(/\$\{?HOME\}?/g, home).replace(/(^|[\s'"=:(<>|;&])~(?=\/|[\s'"]|$)/g, `$1${home}`);
  // Each path-like word, normalised: /home/me/.codex/./auth.json → /home/me/.codex/auth.json.
  const words = expanded.split(/[\s'"=:(<>|;&]+/).filter((w) => w.includes('/') || w.startsWith('.'));
  const normalised = words.map((w) => normalize(w));
  const guarded = credentialPaths(home);
  for (const word of normalised) {
    const hit = guarded.find((g) => word === g || word.startsWith(g + sep));
    if (hit) return hit;
    // Relative: a word ending in a guarded store's own tail (".codex/auth.json", ".ssh/id_rsa").
    const tail = CREDENTIAL_PATHS.find((rel) => word === rel || word.endsWith(`/${rel}`) || word.startsWith(`${rel}/`) || word.includes(`/${rel}/`));
    if (tail) return resolve(home, tail);
    if (isEnvFile(word)) return word;
  }
  if (/\/proc\/[^\s/]+\/environ/.test(command)) return '/proc/<pid>/environ';
  return undefined;
}

/**
 * Could this command reach a credential store in a way the text check can't follow? Globs and
 * variables in a word that starts in a hidden folder of your home (`cat ~/.cod*\/auth.json`). Not
 * blocked — plenty of ordinary commands look like this — but never run without asking.
 */
export function mightReachCredentials(command: string, home = homedir()): boolean {
  if (credentialReferenceIn(command, home)) return true;
  const expanded = command.replace(/\$\{?HOME\}?/g, home).replace(/(^|[\s'"=:(<>|;&])~(?=\/)/g, `$1${home}`);
  return expanded.split(/[\s'"=:(<>|;&]+/).some((w) => (w.startsWith(`${home}/.`) || /^(\.\/)*\.[^./]/.test(w)) && /[*?[{$]/.test(w));
}

export function blockedMessage(path: string): string {
  return (
    `Blocked: ${path} holds credentials, and polyphemus tools don't read or write credential stores. ` +
    'If the user needs something from it, ask them to check it themselves.'
  );
}

/** Env var names that usually hold secrets (ANTHROPIC_API_KEY, GH_TOKEN, AWS_SECRET_ACCESS_KEY, DB_PASSWORD…). */
const SECRET_ENV = /(KEY|TOKEN|PASSWORD|PASSWD|CREDENTIALS?)$|SECRET/i;

/** The environment tools run in: the current one minus anything that looks like a secret. */
export function toolEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(base).filter(([name]) => !SECRET_ENV.test(name)));
}

/** The sign-in variables each vendor CLI reads itself: the only secrets its environment keeps. */
const CLI_SIGN_IN_ENV: Record<string, RegExp> = {
  'claude-cli': /^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN)$/,
  'codex-cli': /^(OPENAI_API_KEY|CODEX_API_KEY)$/,
  'grok-cli': /^(XAI_API_KEY|GROK_API_KEY)$/,
};

/**
 * A vendor CLI's environment: this computer's, without polyphemus's other secrets. Until 2026-09-16 each
 * CLI got polyphemus's whole environment — every provider's API key — which its shell tool could print.
 */
export function cliEnvironment(adapter: string | undefined, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const own = adapter ? CLI_SIGN_IN_ENV[adapter] : undefined;
  return Object.fromEntries(Object.entries(base).filter(([name]) => !SECRET_ENV.test(name) || own?.test(name)));
}
