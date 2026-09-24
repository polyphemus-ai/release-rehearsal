import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { codexSandbox, type SandboxCheck } from './agents/codex-sandbox.js';
import type { Adapter } from './config.js';
import { findOnPath, inWsl, toolsPrefix } from './platform.js';

// What's already on this computer, and whether it's signed in. A fresh install shouldn't start
// with an empty form: the vendor CLIs are usually already here and already logged in, and both
// facts can be had for nothing (docs/design/capacity.md has the same argument about usage).
//
// OpenClaw's Model Setup shows "Claude Code · Detected · installed; login status unverified".
// Polyphemus can do better than unverified: each CLI answers its own status non-interactively.

const run = promisify(execFile);

/** The commands each adapter uses: the binary, how to ask about auth, and how to sign in. */
const CLI: Partial<Record<Adapter, { command: string; status: string[]; login: string[] }>> = {
  'claude-cli': { command: 'claude', status: ['auth', 'status'], login: ['auth', 'login'] },
  'codex-cli': { command: 'codex', status: ['login', 'status'], login: ['login'] },
  // Grok has no `auth status` (1.0.40 says "unrecognized subcommand"), so it was never known to be
  // signed in or out; `grok models` says which, in words. Its device sign-in prints a link and a
  // code that work from any device — a phone, or Windows outside WSL — where the default waits for a
  // browser on this computer (2026-09-23).
  'grok-cli': { command: 'grok', status: ['models'], login: ['login', '--device-auth'] },
};

export interface CliState {
  /** The binary is on PATH. */
  installed: boolean;
  /** It says it's signed in. Undefined when it wouldn't say either way. */
  signedIn?: boolean;
  /** Who, when it says: an email or a plan name. */
  account?: string;
  /** What to run by hand, for when polyphemus can't do the signing in for you. */
  loginCommand?: string;
  /** Codex on Linux: whether its sandbox can run commands here. Absent where there's nothing to check. */
  sandbox?: SandboxCheck;
  /** Inside WSL: not installed in Linux, but installed on Windows — which Polyphemus can't use. */
  onWindows?: boolean;
}

/**
 * How each CLI is installed: the vendor's own installer where there is one (both put it under the
 * person's home folder and need no password; Claude's refuses to run under sudo), or npm into
 * Polyphemus's own folder. Never the system's folders. install/install.sh offers the same three.
 */
const INSTALL: Partial<Record<Adapter, { script: string } | { npm: string }>> = {
  'claude-cli': { script: 'https://claude.ai/install.sh' },
  'codex-cli': { npm: '@openai/codex' },
  'grok-cli': { script: 'https://x.ai/cli/install.sh' },
};

/** The npm beside the Node running Polyphemus, which is the one its own install used. */
const npmCommand = (): string => {
  const beside = join(dirname(process.execPath), 'npm');
  return existsSync(beside) ? beside : 'npm';
};

/** The install, as a person would type it: shown before it runs. */
export const cliInstallCommand = (adapter: string): string | undefined => {
  const how = INSTALL[adapter as Adapter];
  if (!how) return undefined;
  return 'script' in how ? `curl -fsSL ${how.script} | bash` : `npm install -g --prefix ${toolsPrefix()} ${how.npm}`;
};

/** Whether an adapter is a vendor CLI polyphemus can look for. */
export const isCliAdapter = (adapter: string): boolean => adapter in CLI;

export const cliLoginCommand = (adapter: string): string | undefined => {
  const cli = CLI[adapter as Adapter];
  return cli && `${cli.command} ${cli.login.join(' ')}`;
};

/**
 * Asks a CLI about itself. Never throws: not installed, not signed in and not answering are all
 * ordinary answers, and each is more useful than a failure.
 */
export async function cliState(adapter: string, deps: { sandbox?: (command: string) => Promise<SandboxCheck | undefined> } = {}): Promise<CliState | undefined> {
  const cli = CLI[adapter as Adapter];
  if (!cli) return undefined;
  const loginCommand = `${cli.command} ${cli.login.join(' ')}`;
  // Found the way Polyphemus will run it: inside WSL, a Windows build on the PATH doesn't count.
  const binary = findOnPath(cli.command);
  if (!binary) {
    const onWindows = inWsl() && Boolean(findOnPath(`${cli.command}.exe`, { windows: true }) ?? findOnPath(cli.command, { windows: true }));
    return { installed: false, loginCommand, ...(onWindows && { onWindows }) };
  }
  let output: string;
  try {
    const { stdout, stderr } = await run(binary, cli.status, { timeout: 20_000 });
    output = `${stdout}\n${stderr}`;
  } catch (err) {
    const failure = err as { code?: string; stdout?: string; stderr?: string };
    // ENOENT means the binary isn't here at all; anything else means it ran and was unhappy,
    // which usually is the answer ("not logged in" often exits non-zero).
    if (failure.code === 'ENOENT') return { installed: false, loginCommand };
    output = `${failure.stdout ?? ''}\n${failure.stderr ?? ''}`;
  }
  // Codex can be installed and signed in and still unable to run a single command (codex-sandbox.ts).
  const sandbox = adapter === 'codex-cli' ? await (deps.sandbox ?? codexSandbox)(cli.command) : undefined;
  return { installed: true, ...readStatus(output), loginCommand, ...(sandbox && { sandbox }) };
}

/** Reads a CLI's own words about whether it's signed in, and as whom. */
export function readStatus(output: string): { signedIn?: boolean; account?: string } {
  const text = output.trim();
  if (!text) return {};
  // Claude Code answers in JSON: { "loggedIn": true, "email": "…", "authMethod": "claude.ai" }.
  const brace = text.indexOf('{');
  if (brace >= 0) {
    try {
      const json = JSON.parse(text.slice(brace, text.lastIndexOf('}') + 1)) as Record<string, unknown>;
      if (typeof json.loggedIn === 'boolean') {
        const account = [json.email, json.authMethod].find((value) => typeof value === 'string' && value) as string | undefined;
        return { signedIn: json.loggedIn, ...(json.loggedIn && account ? { account } : {}) };
      }
    } catch {
      // Not JSON after all; fall through to reading the prose.
    }
  }
  // Codex answers in prose: "Logged in using ChatGPT".
  if (/\b(not logged in|logged out|no credentials|not authenticated|please (log|sign) in)\b/i.test(text)) return { signedIn: false };
  const loggedIn = /\b(logged in|signed in|authenticated)\b/i.test(text);
  if (!loggedIn) return {};
  // To the end of the line, less a closing full stop: an account is often a domain or an address.
  const using = /\b(?:logged in|signed in) (?:using|as|with) ([^\n]+?)\.?[ \t]*(?:\n|$)/i.exec(text);
  return { signedIn: true, ...(using ? { account: using[1]!.trim() } : {}) };
}

/**
 * Starts a CLI's own sign-in, reporting each line as it comes. The flow finishes in a browser on
 * this machine, so polyphemus can start it and watch, but never complete it — `onLine` is how the
 * URL or code it prints reaches whoever asked.
 */
export function startCliLogin(adapter: string, onLine: (line: string) => void): { done: Promise<boolean>; cancel: () => void } | undefined {
  const cli = CLI[adapter as Adapter];
  if (!cli) return undefined;
  return watch(spawn(cli.command, cli.login, { stdio: ['ignore', 'pipe', 'pipe'] }), onLine);
}

/**
 * Installs a CLI the way INSTALL says, on the person's word, reporting each line as it comes.
 * Nothing it runs asks for a password: a vendor installer that did would fail here, and say so.
 */
export function startCliInstall(adapter: string, onLine: (line: string) => void): { done: Promise<boolean>; cancel: () => void } | undefined {
  const how = INSTALL[adapter as Adapter];
  if (!how) return undefined;
  const env = { ...process.env, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}` };
  const child =
    'script' in how
      ? spawn('bash', ['-c', 'set -o pipefail; curl -fsSL "$1" | bash', 'install', how.script], { stdio: ['ignore', 'pipe', 'pipe'], env })
      : spawn(npmCommand(), ['install', '-g', '--prefix', toolsPrefix(), '--no-fund', '--no-audit', how.npm], { stdio: ['ignore', 'pipe', 'pipe'], env });
  return watch(child, onLine);
}

/** A child's output a line at a time, and whether it finished well; ten minutes at most. */
function watch(child: ChildProcess, onLine: (line: string) => void): { done: Promise<boolean>; cancel: () => void } {
  let buffer = '';
  const take = (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) if (line.trim()) onLine(line.trim());
  };
  child.stdout?.on('data', take);
  child.stderr?.on('data', take);
  const done = new Promise<boolean>((resolve) => {
    child.on('error', () => resolve(false));
    child.on('close', (code) => {
      if (buffer.trim()) onLine(buffer.trim());
      resolve(code === 0);
    });
  });
  // Never let a browser flow nobody finished hold a process open forever.
  const timer = setTimeout(() => child.kill(), 10 * 60_000);
  timer.unref();
  return {
    done: done.finally(() => clearTimeout(timer)),
    cancel: () => child.kill(),
  };
}
