import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

// Codex runs every command an agent gives it inside its own sandbox. On Linux that's bubblewrap
// (`bwrap`, the system one at /usr/bin/bwrap when there is one, else the copy Codex ships), which
// needs unprivileged user and network namespaces. Ubuntu 23.10 and later restrict those through
// AppArmor (kernel.apparmor_restrict_unprivileged_userns = 1), and then every command fails before it
// starts ("bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted") — the agent can only
// report it in chat, and guesses at why. So polyphemus checks for itself, the same way Codex runs a
// command: `codex sandbox -- true` goes through Codex's own sandbox, costs no model call, and takes
// a few hundredths of a second. On macOS Codex uses Seatbelt and on Windows its own sandbox, so
// there's nothing of this kind to check there.

/** What polyphemus found out about whether Codex's sandbox can run on this computer. */
export interface SandboxCheck {
  ok: boolean;
  /** Why it can't, when polyphemus can tell: Ubuntu's AppArmor restriction, or namespaces turned off in the kernel. */
  cause?: 'apparmor' | 'userns-disabled';
  /** What the sandbox printed, trimmed. */
  output?: string;
  /** In words, for the owner — only when it can't run. */
  explanation?: SandboxExplanation;
  checkedAt: number;
}

export interface SandboxExplanation {
  /** What's wrong. */
  problem: string;
  /** Why, as far as polyphemus can tell. */
  why: string;
  /** What the owner can do about it, in order of preference. Polyphemus never changes the machine itself. */
  fixes: Array<{ title: string; steps: string[]; tradeoff: string }>;
}

export interface SandboxProbeDeps {
  platform?: NodeJS.Platform;
  /** Runs a command; `missing` when the binary isn't there, `timedOut` when it didn't finish. */
  run?(command: string, args: string[]): Promise<{ code: number | null; output: string; missing?: boolean; timedOut?: boolean }>;
  /** Reads a kernel setting from /proc/sys, trimmed; undefined when it doesn't exist. */
  setting?(path: string): string | undefined;
  /** Whether a file exists (for /usr/bin/bwrap). */
  exists?(path: string): boolean;
}

/** What failing to get a namespace looks like, from bwrap, Codex's own wrapper, or `unshare`. */
const NAMESPACE_FAILURE = /RTM_NEWADDR|RTM_NEWLINK|uid.?map|new namespace|namespace|bwrap:|Operation not permitted/i;

/**
 * Runs a trivial command through Codex's sandbox. Undefined when there's nothing to say: not Linux,
 * Codex isn't installed, or it failed in a way that isn't the sandbox (polyphemus doesn't claim a cause
 * it can't see).
 */
export async function probeCodexSandbox(command = 'codex', deps: SandboxProbeDeps = {}): Promise<SandboxCheck | undefined> {
  const platform = deps.platform ?? process.platform;
  if (platform !== 'linux') return undefined;
  const run = deps.run ?? runQuietly;
  const setting = deps.setting ?? readSetting;
  const now = Date.now();

  let result = await run(command, ['sandbox', '--', 'true']);
  if (result.missing || result.timedOut) return undefined;
  // A Codex from before `codex sandbox` (clap's usage error): check the capability it needs directly.
  if (result.code === 2 && /unrecognized subcommand|Usage:/i.test(result.output) && !NAMESPACE_FAILURE.test(result.output)) {
    result = await run('unshare', ['--user', '--map-root-user', '--net', 'true']);
    if (result.missing || result.timedOut) return undefined;
  }
  if (result.code === 0) return { ok: true, checkedAt: now };

  const cause =
    setting('kernel/apparmor_restrict_unprivileged_userns') === '1'
      ? 'apparmor'
      : setting('kernel/unprivileged_userns_clone') === '0' || setting('user/max_user_namespaces') === '0'
        ? 'userns-disabled'
        : undefined;
  if (!NAMESPACE_FAILURE.test(result.output)) return undefined;
  const output = result.output.trim().split('\n').slice(-3).join('\n').slice(0, 300);
  const check: SandboxCheck = { ok: false, ...(cause && { cause }), ...(output && { output }), checkedAt: now };
  return { ...check, explanation: explainSandbox(check, (deps.exists ?? existsSync)('/usr/bin/bwrap')) };
}

/** The problem, why, and what the owner can do — the machine-level fix is theirs to make. */
export function explainSandbox(check: Pick<SandboxCheck, 'cause' | 'output'>, systemBwrap = true): SandboxExplanation {
  const problem =
    'Codex can’t run commands on this computer: its sandbox (bubblewrap) can’t start, so every command Codex runs fails before it starts, including the ones it reads files with.';
  const why =
    check.cause === 'apparmor'
      ? 'This Linux restricts unprivileged user namespaces through AppArmor (kernel.apparmor_restrict_unprivileged_userns = 1, on by default since Ubuntu 24.04), and Codex’s sandbox needs them.'
      : check.cause === 'userns-disabled'
        ? 'Unprivileged user namespaces are turned off in this computer’s kernel (kernel.unprivileged_userns_clone = 0 or user.max_user_namespaces = 0), and Codex’s sandbox needs them.'
        : `Codex’s sandbox couldn’t create the namespaces it needs${check.output ? `. It said: ${check.output}` : '.'}`;
  const bwrap = '/usr/bin/bwrap';
  const fixes: SandboxExplanation['fixes'] = [];
  if (check.cause === undefined) {
    fixes.push({
      title: 'Check that unprivileged user namespaces work here',
      steps: ['unshare --user --map-root-user --net true && echo namespaces work', 'codex sandbox -- true && echo the sandbox works'],
      tradeoff: 'Polyphemus couldn’t tell what blocks them on this computer: a container without namespaces, a security module, or a kernel setting are the usual causes.',
    });
  } else if (check.cause === 'apparmor') {
    fixes.push({
      title: 'Allow namespaces for bubblewrap only (recommended)',
      steps: [
        ...(systemBwrap ? [] : ['sudo apt install bubblewrap   # Codex uses /usr/bin/bwrap when it’s there']),
        `sudo tee /etc/apparmor.d/bwrap <<'EOF'\nabi <abi/4.0>,\ninclude <tunables/global>\n\nprofile bwrap ${bwrap} flags=(unconfined) {\n  userns,\n  include if exists <local/bwrap>\n}\nEOF`,
        'sudo apparmor_parser -r /etc/apparmor.d/bwrap',
      ],
      tradeoff: 'Only bubblewrap gets the exception, but any program on this computer can use bubblewrap to get a namespace, which is part of what the restriction was closing.',
    });
    fixes.push({
      title: 'Or turn the restriction off for every program',
      steps: [
        'sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0',
        "echo 'kernel.apparmor_restrict_unprivileged_userns = 0' | sudo tee /etc/sysctl.d/60-userns.conf   # keeps it after a restart",
      ],
      tradeoff: 'Simplest, but it reopens, for every program, the kernel attack surface Ubuntu closed on purpose.',
    });
  } else {
    fixes.push({
      title: 'Turn unprivileged user namespaces back on',
      steps: ['sudo sysctl -w kernel.unprivileged_userns_clone=1 user.max_user_namespaces=15000', 'Add the same settings to a file in /etc/sysctl.d/ to keep them after a restart.'],
      tradeoff: 'Every program can create user namespaces again, which is what the setting was keeping from them.',
    });
  }
  return { problem, why, fixes };
}

/** The one-line version, for a notice in a thread. */
export function sandboxNotice(check: SandboxCheck, providerId: string): string {
  const cause =
    check.cause === 'apparmor'
      ? ' This Linux restricts unprivileged user namespaces through AppArmor (kernel.apparmor_restrict_unprivileged_userns = 1), and the sandbox needs them.'
      : check.cause === 'userns-disabled'
        ? ' Unprivileged user namespaces are turned off in this computer’s kernel, and the sandbox needs them.'
        : check.output
          ? ` It said: ${check.output.split('\n').at(-1)}`
          : '';
  return `${providerId} can’t run commands on this computer: Codex’s sandbox (bubblewrap) can’t start, so every command it tries fails before it runs.${cause} The fix is a setting on this computer for you to change: Models & providers shows how, on Codex’s card, where you can also choose to run Codex without its sandbox. Until then, pick another model for work that needs commands.`;
}

const CACHE_OK_MS = 30 * 60_000;
// A failure is rechecked sooner, so the warning goes away soon after the owner fixes the machine.
const CACHE_FAILED_MS = 2 * 60_000;
const cache = new Map<string, Promise<SandboxCheck | undefined>>();
const cachedAt = new Map<string, { at: number; ok: boolean | undefined }>();

/** The probe, remembered for a while: it's cheap, but the providers screen and every Codex turn ask. */
export function codexSandbox(command = 'codex', deps?: SandboxProbeDeps): Promise<SandboxCheck | undefined> {
  const last = cachedAt.get(command);
  const hit = cache.get(command);
  if (hit && last && Date.now() - last.at < (last.ok === false ? CACHE_FAILED_MS : CACHE_OK_MS)) return hit;
  const probe = probeCodexSandbox(command, deps).catch(() => undefined);
  cache.set(command, probe);
  cachedAt.set(command, { at: Date.now(), ok: undefined });
  void probe.then((check) => cachedAt.set(command, { at: Date.now(), ok: check?.ok }));
  return probe;
}

export function forgetCodexSandbox(): void {
  cache.clear();
  cachedAt.clear();
}

function readSetting(path: string): string | undefined {
  try {
    return readFileSync(`/proc/sys/${path}`, 'utf8').trim();
  } catch {
    return undefined;
  }
}

function runQuietly(command: string, args: string[]): Promise<{ code: number | null; output: string; missing?: boolean; timedOut?: boolean }> {
  return new Promise((resolve) => {
    // From a temporary folder: `codex sandbox` makes the working folder writable to the command.
    execFile(command, args, { cwd: tmpdir(), timeout: 15_000 }, (err, stdout, stderr) => {
      const output = `${stdout}\n${stderr}`.trim();
      if (!err) return resolve({ code: 0, output });
      const failure = err as NodeJS.ErrnoException & { code?: string | number; killed?: boolean };
      if (failure.code === 'ENOENT') return resolve({ code: null, output, missing: true });
      if (failure.killed) return resolve({ code: null, output, timedOut: true });
      resolve({ code: typeof failure.code === 'number' ? failure.code : 1, output });
    });
  });
}
