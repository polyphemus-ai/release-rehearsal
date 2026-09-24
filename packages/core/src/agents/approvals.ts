import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { obj } from './common.js';
import { assetPath } from '../assets.js';

export interface PermissionRequest {
  tool: string;
  input: Record<string, unknown>;
}

export type PermissionDecision = { allow: true } | { allow: false; message?: string };

/** How to hook an agent CLI up to polyphemus for approvals (Claude Code: --mcp-config + --permission-prompt-tool). */
export interface PermissionPrompt {
  mcpConfig: string;
  toolName: string;
}

export interface ApprovalBridge extends PermissionPrompt {
  close(): void;
}

const SERVER_SCRIPT = assetPath('core', 'bin/approval-mcp.mjs');

/**
 * Lets an agent CLI ask the polyphemus user before running a tool. Claude Code
 * calls a small MCP server (bin/approval-mcp.mjs), which forwards each request
 * here over a socket in a private temp folder. A random token keeps other local
 * processes from answering.
 */
export async function startApprovalBridge(ask: (request: PermissionRequest) => Promise<PermissionDecision>): Promise<ApprovalBridge> {
  const dir = mkdtempSync(join(tmpdir(), 'polyphemus-approvals-')); // created 0700
  const socketPath = join(dir, 'bridge.sock');
  const token = randomBytes(16).toString('hex');

  const server = createServer((socket) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('error', () => {});
    socket.on('data', async (chunk: string) => {
      buffer += chunk;
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      const line = buffer.slice(0, end);
      buffer = '';
      let request: Record<string, unknown>;
      try {
        request = obj(JSON.parse(line));
      } catch {
        socket.end();
        return;
      }
      if (request.token !== token) {
        socket.end(`${JSON.stringify({ behavior: 'deny', message: 'Not authorized.' })}\n`);
        return;
      }
      let decision: PermissionDecision;
      try {
        decision = await ask({ tool: String(request.tool_name ?? 'tool'), input: obj(request.input) });
      } catch {
        decision = { allow: false, message: 'The approval prompt was interrupted.' };
      }
      const reply = decision.allow ? { behavior: 'allow' } : { behavior: 'deny', message: decision.message ?? 'The user declined this tool call.' };
      socket.end(`${JSON.stringify(reply)}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });

  const mcpConfig = JSON.stringify({
    mcpServers: {
      polyphemus: {
        type: 'stdio',
        command: process.execPath,
        args: [SERVER_SCRIPT],
        env: { POLYPHEMUS_APPROVAL_SOCKET: socketPath, POLYPHEMUS_APPROVAL_TOKEN: token },
      },
    },
  });
  return {
    mcpConfig,
    toolName: 'mcp__polyphemus__approve',
    close: () => {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
