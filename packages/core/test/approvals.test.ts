import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { createInterface } from 'node:readline';
import { describe, expect, it } from 'vitest';
import { startApprovalBridge, type PermissionRequest } from '../src/agents/approvals.js';

interface ServerEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

describe('approval bridge', () => {
  it('relays a request from the MCP tool to polyphemus and the answer back', async () => {
    const seen: PermissionRequest[] = [];
    const bridge = await startApprovalBridge(async (request) => {
      seen.push(request);
      return request.input.command === 'git init' ? { allow: true } : { allow: false, message: 'Not that one.' };
    });
    try {
      const server = (JSON.parse(bridge.mcpConfig) as { mcpServers: { polyphemus: ServerEntry } }).mcpServers.polyphemus;
      expect(bridge.toolName).toBe('mcp__polyphemus__approve');

      const child = spawn(server.command, server.args, { env: { ...process.env, ...server.env }, stdio: ['pipe', 'pipe', 'inherit'] });
      const requests = [
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'approve', arguments: { tool_name: 'Bash', input: { command: 'git init' } } } },
        { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'approve', arguments: { tool_name: 'Bash', input: { command: 'rm -rf /' } } } },
      ];
      child.stdin.end(requests.map((r) => JSON.stringify(r)).join('\n') + '\n');

      const replies: Array<{ id: number; result: { tools?: Array<{ name: string }>; content?: Array<{ text: string }> } }> = [];
      for await (const line of createInterface({ input: child.stdout })) replies.push(JSON.parse(line));

      expect(replies.map((r) => r.id)).toEqual([1, 2, 3, 4]);
      expect(replies[1]?.result.tools?.[0]?.name).toBe('approve');
      expect(JSON.parse(replies[2]?.result.content?.[0]?.text ?? '')).toEqual({ behavior: 'allow', updatedInput: { command: 'git init' } });
      expect(JSON.parse(replies[3]?.result.content?.[0]?.text ?? '')).toEqual({ behavior: 'deny', message: 'Not that one.' });
      expect(seen.map((s) => s.tool)).toEqual(['Bash', 'Bash']);
    } finally {
      bridge.close();
    }
  });

  it('refuses callers without the token', async () => {
    let asked = false;
    const bridge = await startApprovalBridge(async () => {
      asked = true;
      return { allow: true };
    });
    try {
      const server = (JSON.parse(bridge.mcpConfig) as { mcpServers: { polyphemus: ServerEntry } }).mcpServers.polyphemus;
      const reply = await new Promise<string>((resolve) => {
        const socket = createConnection(server.env.POLYPHEMUS_APPROVAL_SOCKET!);
        let data = '';
        socket.on('connect', () => socket.write(`${JSON.stringify({ token: 'wrong', tool_name: 'Bash', input: {} })}\n`));
        socket.on('data', (chunk) => (data += chunk));
        socket.on('close', () => resolve(data));
      });
      expect(JSON.parse(reply)).toEqual({ behavior: 'deny', message: 'Not authorized.' });
      expect(asked).toBe(false);
    } finally {
      bridge.close();
    }
  });
});
