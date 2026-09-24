import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { PolyphemusEvent } from '../events.js';
import { imageBase64 } from '../images.js';
import type { CapacityReading, ImageBlock, ModelInfo } from '../types.js';
import { fromClaudeStream } from './claude-stream.js';
import { runGrokAsked, runGrokIsolated } from '../isolation/grok.js';
import { runCli, type AgentProvider, type AgentRunRequest, type CliAgentOptions } from './common.js';

/** Claude Code (`claude -p`) on the user's Claude Pro/Max subscription. */
export class ClaudeCodeAgent implements AgentProvider {
  readonly kind = 'agent' as const;

  constructor(
    readonly id: string,
    private opts: CliAgentOptions = {},
  ) {}

  run(req: AgentRunRequest): AsyncIterable<PolyphemusEvent> {
    const command = this.opts.command ?? 'claude';
    const images = req.images ?? [];
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
    // Images go in a stream-json user message, which -p reads from stdin just like a plain prompt.
    if (images.length > 0) args.push('--input-format', 'stream-json');
    if (req.autoApprove) args.push('--dangerously-skip-permissions');
    // `default`: every change reaches Polyphemus's approval bridge. `acceptEdits` also lets Claude Code run
    // rm, mv, cp and mkdir in the project unasked (polyphemus.ts, DEFAULT_PERMISSION_MODE).
    else args.push('--permission-mode', req.readOnly ? 'default' : (this.opts.permissionMode ?? 'default'));
    if (req.model !== 'default') args.push('--model', req.model);
    if (req.resume) args.push('--resume', req.resume);
    for (const dir of req.extraDirs ?? []) args.push('--add-dir', dir);
    if (req.systemAppend) args.push('--append-system-prompt', req.systemAppend);
    // Anything the permission mode wouldn't allow is asked of the polyphemus user instead of denied.
    // Both of polyphemus's MCP servers go in one config: the approval prompt, and the connections gateway.
    const prompt = req.permissionPrompt && !req.autoApprove ? req.permissionPrompt : undefined;
    const servers: Record<string, { env?: Record<string, string> }> = prompt ? { ...(JSON.parse(prompt.mcpConfig) as { mcpServers: Record<string, { env?: Record<string, string> }> }).mcpServers } : {};
    if (req.connections) {
      const { serverName, command: server, args: serverArgs, env } = req.connections;
      servers[serverName] = { type: 'stdio', command: server, args: serverArgs, env } as { env: Record<string, string> };
    }
    // Isolated: polyphemus's own servers carry the nonce that lets them start on this computer.
    if (req.isolation) for (const server of Object.values(servers)) server.env = { ...server.env, POLYPHEMUS_HOST_NONCE: req.isolation.hostNonce };
    // In a file only this user can read, never on the command line: the connections gateway's token
    // is in here, and on Linux anyone on the machine can read a process's arguments
    // (connections review, 2026-09-20).
    let configDir: string | undefined;
    if (Object.keys(servers).length > 0) {
      configDir = mkdtempSync(join(tmpdir(), 'polyphemus-mcp-'));
      const file = join(configDir, 'mcp.json');
      writeFileSync(file, JSON.stringify({ mcpServers: servers }), { mode: 0o600 });
      args.push('--mcp-config', file);
    }
    // Claude Code's own schedulers live only as long as its process, which polyphemus ends with the turn:
    // a job made with them never runs. Scheduled work is a poly routine (propose_routine).
    // Its own question form has nobody to answer it here: it comes back "the user did not answer".
    // An agent asks in its reply instead, and @mentioning the person is what reaches them.
    const notHere = ['CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup', 'RemoteTrigger', 'AskUserQuestion'];
    if (req.isolation) {
      // Nothing from the project's own settings or MCP files: a model can write those, and they could
      // unset the prefix, add a hook or a server that runs here.
      args.push('--strict-mcp-config', '--setting-sources', 'user', '--disallowedTools', ...req.isolation.blockedTools, ...notHere);
    } else args.push('--disallowedTools', ...notHere);
    if (prompt) args.push('--permission-prompt-tool', prompt.toolName);
    // Polyphemus checks the grant and asks about anything that isn't a read itself, so Claude Code needn't ask again.
    if (req.connections) args.push('--allowedTools', `mcp__${req.connections.serverName}`);
    // The prompt goes over stdin, which has no argv size limit.
    const input =
      images.length > 0
        ? `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: req.prompt }, ...images.map(claudeImage)] } })}\n`
        : req.prompt;
    // Claude Code can start subagents on a model of its own choosing — Fable, when polyphemus ran Opus.
    // Your list of models is the limit on what runs, so they're held to the model this turn is on:
    // with FORCE, the Agent tool loses its model parameter and agent files' `model:` is ignored.
    // (availableModels passed with --settings doesn't reach subagents; only a managed list does.)
    // Letting Claude Code pick ("default"), FORCE alone leaves them on whatever it picked for the turn.
    const pinned = { CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1', ...(req.model !== 'default' && { CLAUDE_CODE_SUBAGENT_MODEL: req.model }) };
    const env = { ...(req.env ?? process.env), ...req.isolation?.env, ...pinned };
    const events = runCli(command, args, { cwd: req.cwd, input, signal: req.signal, env }, fromClaudeStream, {
      providerId: this.id,
      model: req.model,
    });
    if (!configDir) return events;
    // The file lives exactly as long as the turn that needs it.
    const gone = configDir;
    return (async function* () {
      try {
        yield* events;
      } finally {
        rmSync(gone, { recursive: true, force: true });
      }
    })();
  }

  async listModels(): Promise<ModelInfo[]> {
    // The CLI has no list command, so these are the names it accepts. No limits: polyphemus would be
    // guessing, and the API's own list endpoint is where that belongs.
    return ['default', 'opus', 'sonnet', 'haiku', 'claude-opus-5', 'claude-sonnet-5', 'claude-fable-5-1'].map((id) => ({ id }));
  }
}

/**
 * Claude Code's own `/usage`, read without spending anything. It's a local command — `--output-
 * format json` comes back with `num_turns: 0`, `total_cost_usd: 0` and no tokens — so polyphemus can
 * poll it the way it reads codex's logs. Until this, Claude Code's limits only arrived inside the
 * stream of a live turn, so a reading went stale the moment you stopped working.
 *
 * It also reports a window the stream never mentioned: a separate weekly cap for Fable.
 */
export async function readClaudeUsage(command?: string): Promise<{ readings: CapacityReading[]; observedAt?: Date }> {
  let text: string;
  let sessionId: string | undefined;
  try {
    const { stdout } = await promisify(execFile)(command ?? 'claude', ['-p', '/usage', '--output-format', 'json'], {
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const answer = JSON.parse(stdout) as { result?: unknown; session_id?: unknown };
    text = String(answer.result ?? '');
    if (typeof answer.session_id === 'string') sessionId = answer.session_id;
  } catch {
    return { readings: [] };
  }
  // Asking leaves a transcript behind, and polling would pile up hundreds of them in someone
  // else's folder. Polyphemus removes the one it just caused, by the id it was handed, and nothing else.
  if (sessionId) await forgetClaudeSession(sessionId).catch(() => {});
  return { readings: parseClaudeUsage(text), ...(text ? { observedAt: new Date() } : {}) };
}

async function forgetClaudeSession(sessionId: string): Promise<void> {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return;
  const projects = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects');
  for (const dir of await readdir(projects, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const file = join(projects, dir.name, `${sessionId}.jsonl`);
    if (existsSync(file)) {
      await rm(file, { force: true });
      return;
    }
  }
}

/** "Current week (all models): 34% used · resets Sep 14, 7pm (America/Chicago)" → a reading. */
export function parseClaudeUsage(text: string, now = new Date()): CapacityReading[] {
  const readings: CapacityReading[] = [];
  // The names polyphemus already uses for these, so a polled reading replaces a streamed one rather
  // than sitting beside it. Anything else Claude Code lists keeps its own name.
  const windows: Array<[RegExp, string]> = [
    [/^Current session:/i, '5h'],
    [/^Current week \(all models\):/i, '7d'],
  ];
  for (const line of text.split('\n')) {
    const match = /^(.+?):\s*(\d+(?:\.\d+)?)%\s*used(?:\s*·\s*resets\s*([^(]+?))?\s*(?:\(|$)/.exec(line.trim());
    if (!match) continue;
    const [, name, pct, resets] = match;
    const known = windows.find(([pattern]) => pattern.test(`${name}:`));
    const window = known ? known[1] : name!.replace(/^Current\s+/i, '').trim();
    const reading: CapacityReading = { window, usedPct: Number(pct), observedAt: now };
    const at = resets ? parseResetTime(resets.trim(), now) : undefined;
    if (at) reading.resetsAt = at;
    readings.push(reading);
  }
  return readings;
}

/** "Sep 14, 7pm" → a Date, in this machine's zone, rolling to next year if that's already past. */
function parseResetTime(text: string, now: Date): Date | undefined {
  const match = /^([A-Za-z]{3})\s+(\d{1,2}),\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i.exec(text);
  if (!match) return undefined;
  const [, month, day, hour, minute, half] = match;
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const monthIndex = months.indexOf(month!.toLowerCase());
  if (monthIndex < 0) return undefined;
  let hours = Number(hour) % 12;
  if (half!.toLowerCase() === 'pm') hours += 12;
  const at = new Date(now.getFullYear(), monthIndex, Number(day), hours, Number(minute ?? 0), 0, 0);
  // A reset is always ahead of now; a December reading read in January would otherwise look past.
  if (at.getTime() < now.getTime() - 86_400_000) at.setFullYear(at.getFullYear() + 1);
  return at;
}

/** An attached image as a Messages-API content block (or a note, if its file has gone). */
function claudeImage(image: ImageBlock) {
  const data = imageBase64(image);
  return data ? { type: 'image', source: { type: 'base64', media_type: image.mediaType, data } } : { type: 'text', text: '[an attached image that is no longer available]' };
}

/** Grok Build on the user's SuperGrok subscription, driven as its client so a permission question reaches the person. */
export class GrokBuildAgent implements AgentProvider {
  readonly kind = 'agent' as const;

  constructor(
    readonly id: string,
    private opts: CliAgentOptions = {},
  ) {}

  run(req: AgentRunRequest): AsyncIterable<PolyphemusEvent> {
    const command = this.opts.command ?? 'grok';
    // Isolated: its commands and files go to the worker (isolation/grok.ts).
    if (req.isolation?.worker) return runGrokIsolated(command, req, req.isolation.worker, (stats) => req.isolation?.report?.(stats));
    // On this computer Grok runs its own tools. A headless prompt has no permission card, and Grok
    // was recording the missing answer as "User cancelled". Asking here is the same question Claude gets.
    const attached = (req.images ?? []).map((image) => `[The user attached an image, saved at ${image.path}. Open it with your file tools to see it.]`);
    const prompt = attached.length > 0 ? `${req.prompt}\n\n${attached.join('\n')}` : req.prompt;
    return runGrokAsked(command, { ...req, prompt });
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const { stdout } = await promisify(execFile)(this.opts.command ?? 'grok', ['models'], { timeout: 15_000 });
      const ids = stdout.match(/\bgrok-[\w.-]+/g) ?? [];
      return ['default', ...new Set(ids)].map((id) => ({ id }));
    } catch {
      return [{ id: 'default' }];
    }
  }
}
