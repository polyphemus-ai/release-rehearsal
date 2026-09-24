#!/usr/bin/env node
// A tiny MCP server (stdio, JSON-RPC) that Claude Code calls through
// --permission-prompt-tool when a tool call needs approval. Each request is
// forwarded to the polyphemus process over a private local socket; polyphemus asks
// the user and sends the answer back.
import { createConnection } from 'node:net';
import { createInterface } from 'node:readline';

const socketPath = process.env.POLYPHEMUS_APPROVAL_SOCKET;
const token = process.env.POLYPHEMUS_APPROVAL_TOKEN;

const TOOL = {
  name: 'approve',
  description: 'Ask the person using polyphemus whether this tool call may run.',
  inputSchema: {
    type: 'object',
    properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } },
    required: ['tool_name', 'input'],
  },
};

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

function askPolyphemus(args) {
  return new Promise((resolve) => {
    if (!socketPath) return resolve({ behavior: 'deny', message: 'The polyphemus approval bridge is not configured.' });
    const socket = createConnection(socketPath);
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify({ token, tool_name: args.tool_name, input: args.input ?? {} })}\n`));
    socket.on('data', (chunk) => {
      buffer += chunk;
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      socket.end();
      try {
        resolve(JSON.parse(buffer.slice(0, end)));
      } catch {
        resolve({ behavior: 'deny', message: 'Polyphemus sent an unreadable answer.' });
      }
    });
    socket.on('error', (err) => resolve({ behavior: 'deny', message: `Could not reach polyphemus: ${err.message}` }));
  });
}

for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    continue;
  }
  const { id, method, params } = message;
  if (id === undefined) continue; // notifications need no reply
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'polyphemus', version: '0.1.0' },
      },
    });
  } else if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: [TOOL] } });
  } else if (method === 'tools/call') {
    const args = params?.arguments ?? {};
    const decision = await askPolyphemus(args);
    // Claude Code requires updatedInput when allowing; pass the input through unchanged.
    const answer =
      decision.behavior === 'allow'
        ? { behavior: 'allow', updatedInput: args.input ?? {} }
        : { behavior: 'deny', message: decision.message ?? 'The user declined this tool call.' };
    send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(answer) }] } });
  } else if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} });
  } else {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}
