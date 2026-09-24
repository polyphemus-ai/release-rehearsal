import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentProvider } from '../agents/common.js';
import { CLAUDE_HOST_TOOLS, claudeShellWrapper, WORKER_MARKER } from './claude.js';
import { startCodexBridge } from './codex.js';
import type { GrokIsolationStats } from './grok.js';
import type { Worker } from './workers.js';

// Before a vendor CLI's first isolated turn, polyphemus checks — once per version of that CLI — that its
// commands really do run in the worker (docs/design/isolation.md: verify, and fail closed). It's a real
// turn on the smallest model: the CLI is asked to run one command whose output only exists inside a worker.

interface Recorded {
  ok: boolean;
  at: number;
  detail?: string;
}

const file = (home: string) => join(home, 'isolation-checks.json');

function read(home: string): Record<string, Recorded> {
  try {
    return existsSync(file(home)) ? (JSON.parse(readFileSync(file(home), 'utf8')) as Record<string, Recorded>) : {};
  } catch {
    return {};
  }
}

/** The CLI's version, as it reports it: a new version is checked again. */
const versions = new Map<string, { at: number; version: string }>();

/** The CLI's version, as it reports it: a new version is checked again. Asked at most every few minutes. */
export function cliVersion(command: string): string {
  const hit = versions.get(command);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.version;
  const out = spawnSync(command, ['--version'], { encoding: 'utf8', timeout: 15_000 });
  const version = (out.stdout ?? '').trim().split('\n')[0] || 'unknown';
  versions.set(command, { at: Date.now(), version });
  return version;
}

export async function checkClaudeIsolation(opts: { home: string; provider: AgentProvider; command: string; worker: Worker; signal?: AbortSignal }): Promise<Recorded & { key: string; fresh: boolean }> {
  const key = `claude-cli@${cliVersion(opts.command)}`;
  const known = read(opts.home)[key];
  if (known?.ok) return { ...known, key, fresh: false };
  const shell = claudeShellWrapper(opts.worker);
  let output = '';
  let ranThrough = 0;
  try {
    for await (const event of opts.provider.run({
      prompt: 'polyphemus is checking where your commands run. Use the Bash tool to run exactly this command, then reply with only its output: cat /etc/polyphemus-worker',
      model: 'haiku',
      cwd: opts.worker.spec.workdir,
      autoApprove: true,
      isolation: { env: shell.env, hostNonce: shell.hostNonce, blockedTools: [...CLAUDE_HOST_TOOLS, 'WebSearch'] },
      ...(opts.signal && { signal: opts.signal }),
    })) {
      if (event.type === 'message') for (const block of event.message.content) if (block.type === 'tool_result') output += String(block.content);
    }
    ranThrough = shell.runs();
  } catch (err) {
    output += `\n${(err as Error).message}`;
  } finally {
    shell.close();
  }
  const ok = output.includes(WORKER_MARKER) && ranThrough > 0;
  const result: Recorded = { ok, at: Date.now(), ...(!ok && { detail: output.trim().slice(0, 300) || 'it ran no command' }) };
  const all = read(opts.home);
  all[key] = result;
  writeFileSync(file(opts.home), `${JSON.stringify(all, null, 2)}\n`);
  return { ...result, key, fresh: true };
}

export async function checkCodexIsolation(opts: { home: string; provider: AgentProvider; command: string; worker: Worker; binary: string; model: string; signal?: AbortSignal }): Promise<Recorded & { key: string; fresh: boolean }> {
  const key = `codex-cli@${cliVersion(opts.command)}`;
  const known = read(opts.home)[key];
  if (known?.ok) return { ...known, key, fresh: false };
  const bridge = await startCodexBridge(opts.worker, opts.binary);
  let output = '';
  try {
    for await (const event of opts.provider.run({
      prompt: 'polyphemus is checking where your commands run. Run exactly this shell command, then reply with only its output: cat /etc/polyphemus-worker',
      model: opts.model,
      cwd: opts.worker.spec.workdir,
      autoApprove: true,
      isolation: { env: bridge.env, hostNonce: '', blockedTools: [] },
      ...(opts.signal && { signal: opts.signal }),
    })) {
      if (event.type === 'message') for (const block of event.message.content) if (block.type === 'tool_result' || block.type === 'text') output += String(block.type === 'text' ? block.text : block.content);
    }
  } catch (err) {
    output += `\n${(err as Error).message}`;
  } finally {
    await bridge.close();
  }
  const ok = output.includes(WORKER_MARKER) && bridge.processes() > 0;
  const result: Recorded = { ok, at: Date.now(), ...(!ok && { detail: output.trim().slice(0, 300) || 'it ran no command' }) };
  const all = read(opts.home);
  all[key] = result;
  writeFileSync(file(opts.home), `${JSON.stringify(all, null, 2)}\n`);
  return { ...result, key, fresh: true };
}

export async function checkGrokIsolation(opts: { home: string; provider: AgentProvider; command: string; worker: Worker; model: string; signal?: AbortSignal }): Promise<Recorded & { key: string; fresh: boolean }> {
  const key = `grok-cli@${cliVersion(opts.command)}`;
  const known = read(opts.home)[key];
  if (known?.ok) return { ...known, key, fresh: false };
  let output = '';
  let stats: GrokIsolationStats | undefined;
  try {
    for await (const event of opts.provider.run({
      prompt: 'polyphemus is checking where your commands run. Use your shell tool to run exactly this command, then reply with only its output: cat /etc/polyphemus-worker',
      model: opts.model,
      cwd: opts.worker.spec.workdir,
      autoApprove: true,
      isolation: { env: {}, hostNonce: '', blockedTools: [], worker: opts.worker, report: (s) => (stats = s) },
      ...(opts.signal && { signal: opts.signal }),
    })) {
      if (event.type === 'message') for (const block of event.message.content) if (block.type === 'tool_result') output += String(block.content);
    }
  } catch (err) {
    output += `\n${(err as Error).message}`;
  }
  const done = stats as GrokIsolationStats | undefined;
  const ok = output.includes(WORKER_MARKER) && (done?.terminals ?? 0) > 0 && !done?.escaped;
  const result: Recorded = { ok, at: Date.now(), ...(!ok && { detail: (done?.escaped ?? output.trim().slice(0, 300)) || 'it ran no command' }) };
  const all = read(opts.home);
  all[key] = result;
  writeFileSync(file(opts.home), `${JSON.stringify(all, null, 2)}\n`);
  return { ...result, key, fresh: true };
}
