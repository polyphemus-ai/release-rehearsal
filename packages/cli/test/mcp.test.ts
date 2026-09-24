import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { argvFor, mcpTools } from '../src/mcp.js';
import { findCommand } from '../src/commands.js';

describe('polyphemus as an MCP server', () => {
  it('turns read-only commands into tools, with schemas from the command list', () => {
    const tools = mcpTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['capabilities', 'usage', 'sessions', 'sessions_show', 'projects', 'routine_show', 'config_get']));
    expect(names).not.toContain('config_set'); // writes aren't exposed yet
    expect(tools.find((t) => t.name === 'sessions_show')?.inputSchema).toMatchObject({ required: ['id'], properties: { last: { type: 'number' } } });
    expect(argvFor(findCommand('sessions show')!, { id: '3cdf', last: 5 })).toEqual(['sessions', 'show', '3cdf', '--last', '5', '--json']);
    expect(() => argvFor(findCommand('sessions show')!, {})).toThrow('id is required');
  });

  it('answers over stdio like any MCP server', async () => {
    const home = mkdtempSync(join(tmpdir(), 'polyphemus-mcp-'));
    const launcher = fileURLToPath(new URL('../bin/polyphemus.mjs', import.meta.url));
    const child = spawn(process.execPath, [launcher, 'mcp', 'serve'], { env: { ...process.env, POLYPHEMUS_HOME: home, CODEX_HOME: join(home, 'no-codex') }, stdio: ['pipe', 'pipe', 'inherit'] });
    const replies = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    const ask = async (message: object) => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
      return JSON.parse((await replies.next()).value as string) as { result?: any; error?: any };
    };
    try {
      expect((await ask({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })).result.serverInfo.name).toBe('polyphemus');
      expect((await ask({ id: 2, method: 'tools/list' })).result.tools.length).toBeGreaterThan(5);
      const call = await ask({ id: 3, method: 'tools/call', params: { name: 'capabilities', arguments: {} } });
      expect(call.result.isError).toBe(false);
      expect(call.result.structuredContent).toMatchObject({ name: 'polyphemus', paths: { home } });
      const missing = await ask({ id: 4, method: 'tools/call', params: { name: 'sessions_show', arguments: { id: 'nope' } } });
      expect(missing.result.isError).toBe(true);
    } finally {
      child.kill();
    }
  }, 60_000);
});
