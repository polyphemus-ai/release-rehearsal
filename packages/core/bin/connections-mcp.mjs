#!/usr/bin/env node
// The MCP server an agent CLI (Claude Code, Codex) runs to reach poly connections. It holds no
// credentials and talks to no service: it forwards tools/list and tools/call to the polyphemus process
// over a private local socket, and polyphemus checks the grant and makes the call.
import { createConnection } from 'node:net';
import { createInterface } from 'node:readline';

const socketPath = process.env.POLYPHEMUS_CONNECTIONS_SOCKET;
const token = process.env.POLYPHEMUS_CONNECTIONS_TOKEN;

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

function askPolyphemus(request) {
  return new Promise((resolve) => {
    if (!socketPath) return resolve({ error: 'The poly connections gateway is not configured.' });
    const socket = createConnection(socketPath);
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify({ token, ...request })}\n`));
    socket.on('data', (chunk) => {
      buffer += chunk;
    });
    socket.on('end', () => {
      try {
        resolve(JSON.parse(buffer.trim()));
      } catch {
        resolve({ error: 'Polyphemus sent an unreadable answer.' });
      }
    });
    socket.on('error', (err) => resolve({ error: `Could not reach polyphemus: ${err.message}` }));
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
      result: { protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'polyphemus-connections', version: '0.1.0' } },
    });
  } else if (method === 'tools/list') {
    const answer = await askPolyphemus({ op: 'list' });
    send({ jsonrpc: '2.0', id, result: { tools: answer.tools ?? [] } });
  } else if (method === 'tools/call') {
    const answer = await askPolyphemus({ op: 'call', name: params?.name, arguments: params?.arguments ?? {} });
    const text = answer.error ?? answer.content ?? '';
    const images = (answer.images ?? []).map((image) => ({ type: 'image', data: image.data, mimeType: image.mediaType }));
    send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }, ...images], isError: Boolean(answer.error || answer.isError) } });
  } else if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} });
  } else {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}
