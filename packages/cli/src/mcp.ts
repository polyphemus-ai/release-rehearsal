import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { assetPath } from '@polyphemus/core';
import { COMMANDS, type CommandSpec } from './commands.js';

// `poly mcp serve`: polyphemus's read-only commands as MCP tools (stdio, JSON-RPC), generated from the
// same command list as the CLI so the two can't drift. Each call runs the real command with --json
// in its own process, which keeps this process's stdout for the protocol alone.
// Add it to Claude Code with: claude mcp add polyphemus -- poly mcp serve

const LAUNCHER = assetPath('cli', 'bin/polyphemus.mjs');
const VERSION = (JSON.parse(readFileSync(assetPath('cli', 'package.json'), 'utf8')) as { version: string }).version;

const toolName = (id: string) => id.replaceAll('.', '_');
const exposed = () => COMMANDS.filter((c) => c.effects === 'read' && c.json && c.id !== 'help');

export function mcpTools() {
  return exposed().map((c) => ({
    name: toolName(c.id),
    description: `${c.summary.charAt(0).toUpperCase()}${c.summary.slice(1)}. Same as: ${c.usage}`,
    inputSchema: {
      type: 'object',
      properties: Object.fromEntries((c.params ?? []).map((p) => [p.name, { type: p.type, description: p.description }])),
      required: (c.params ?? []).filter((p) => p.required).map((p) => p.name),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }));
}

/** The argv for a tool call: the command's words, its positional arguments, then flags. */
export function argvFor(spec: CommandSpec, input: Record<string, unknown>): string[] {
  const argv = spec.id.split('.');
  for (const p of spec.params ?? []) {
    const value = input[p.name];
    if (value === undefined || value === null || value === '') {
      if (p.required) throw new Error(`${p.name} is required.`);
      continue;
    }
    if (p.flag) argv.push(p.flag, String(value));
    else argv.push(String(value));
  }
  return [...argv, '--json'];
}

function runPolyphemus(argv: string[]): Promise<{ ok: boolean; data?: unknown; error?: { message?: string } }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [LAUNCHER, ...argv], {
      env: { ...process.env, POLYPHEMUS_OUTPUT: 'json', POLYPHEMUS_CALLER: process.env.POLYPHEMUS_CALLER ?? 'an agent (mcp)' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    child.on('close', () => {
      const last = out.trim().split('\n').at(-1) ?? '';
      try {
        resolve(JSON.parse(last) as { ok: boolean; data?: unknown; error?: { message?: string } });
      } catch {
        resolve({ ok: false, error: { message: 'polyphemus gave no answer' } });
      }
    });
  });
}

export async function mcpServe(): Promise<void> {
  const send = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);
  for await (const line of createInterface({ input: process.stdin })) {
    if (!line.trim()) continue;
    let message: { id?: unknown; method?: string; params?: { protocolVersion?: string; name?: string; arguments?: Record<string, unknown> } };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      continue;
    }
    const { id, method, params } = message;
    if (id === undefined) continue; // notifications need no reply
    if (method === 'initialize') {
      send({ jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'polyphemus', version: VERSION } } });
    } else if (method === 'tools/list') {
      send({ jsonrpc: '2.0', id, result: { tools: mcpTools() } });
    } else if (method === 'tools/call') {
      const spec = exposed().find((c) => toolName(c.id) === params?.name);
      if (!spec) {
        send({ jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${String(params?.name)}` } });
        continue;
      }
      let argv: string[];
      try {
        argv = argvFor(spec, params?.arguments ?? {});
      } catch (err) {
        send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: (err as Error).message }], isError: true } });
        continue;
      }
      const answer = await runPolyphemus(argv);
      const payload = answer.ok ? answer.data : answer.error;
      const structured = payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? { structuredContent: payload } : {};
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(payload ?? null) }], ...structured, isError: !answer.ok } });
    } else if (method === 'ping') {
      send({ jsonrpc: '2.0', id, result: {} });
    } else {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${String(method)}` } });
    }
  }
}
