import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CallResult } from './manager.js';
import { assetPath } from '../assets.js';

// How an agent CLI (Claude Code, Codex) reaches connections without ever holding a credential or
// talking to a service itself. The CLI runs bin/connections-mcp.mjs as an MCP server; that server has
// only a socket and a token, and forwards tools/list and tools/call here, where the grant is checked
// at the moment of the call — the same check polyphemus's own tool loop makes.

export interface GatewayTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface GatewayHandler {
  /** The tools the current speaker may call, named as the CLI will see them. */
  list(): GatewayTool[];
  call(name: string, args: Record<string, unknown>): Promise<CallResult>;
}

export interface ConnectionGateway {
  /** The MCP server's name in the CLI's config. Claude Code calls its tools `mcp__<name>__<tool>`. */
  serverName: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  close(): void;
}

const SERVER_SCRIPT = assetPath('core', 'bin/connections-mcp.mjs');
export const GATEWAY_SERVER = 'polyphemus_connections';

export async function startConnectionGateway(handler: GatewayHandler): Promise<ConnectionGateway> {
  const dir = mkdtempSync(join(tmpdir(), 'polyphemus-connections-')); // created 0700
  const socketPath = join(dir, 'gateway.sock');
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
      let request: { token?: unknown; op?: unknown; name?: unknown; arguments?: unknown };
      try {
        request = JSON.parse(line);
      } catch {
        socket.end();
        return;
      }
      if (request.token !== token) {
        socket.end(`${JSON.stringify({ error: 'Not authorized.' })}\n`);
        return;
      }
      try {
        if (request.op === 'list') {
          socket.end(`${JSON.stringify({ tools: handler.list() })}\n`);
        } else if (request.op === 'call' && typeof request.name === 'string') {
          const args = request.arguments && typeof request.arguments === 'object' ? (request.arguments as Record<string, unknown>) : {};
          socket.end(`${JSON.stringify(await handler.call(request.name, args))}\n`);
        } else {
          socket.end(`${JSON.stringify({ error: 'Unknown request.' })}\n`);
        }
      } catch (err) {
        socket.end(`${JSON.stringify({ content: `Polyphemus couldn’t make that call: ${(err as Error).message}`, isError: true })}\n`);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  return {
    serverName: GATEWAY_SERVER,
    command: process.execPath,
    args: [SERVER_SCRIPT],
    env: { POLYPHEMUS_CONNECTIONS_SOCKET: socketPath, POLYPHEMUS_CONNECTIONS_TOKEN: token },
    close: () => {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
