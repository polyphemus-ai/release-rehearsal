#!/usr/bin/env node
// A stand-in for a real service's MCP server, for tests: a CRM with contacts to read and write.
// A CONTACTS_TOKEN that is missing or starts with "expired" or "old" is refused the way an expired credential is.
import { createInterface } from 'node:readline';

// Named for contacts unless told otherwise (`mcp-contacts.mjs orders`), so one fixture can stand in for several services.
const noun = process.argv[2] ?? 'contacts';
const tools = [
  { name: `read_${noun}`, description: `List ${noun}`, inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
  { name: `write_${noun}`, description: `Update ${noun}`, inputSchema: { type: 'object', properties: { count: { type: 'number' } } }, annotations: { destructiveHint: true } },
  { name: `delete_${noun}`, description: `Delete ${noun}`, inputSchema: { type: 'object', properties: {} } },
];
const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) continue;
  if (method === 'initialize') send({ jsonrpc: '2.0', id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'contacts', version: '1' } } });
  else if (!process.env.CONTACTS_TOKEN || /^(expired|old)/.test(process.env.CONTACTS_TOKEN)) send({ jsonrpc: '2.0', id, error: { code: -32001, message: '401 Unauthorized: the token has expired' } });
  // One action the credential may not take. Not a broken sign-in: the token was accepted.
  else if (process.env.CONTACTS_TOKEN === 'narrow' && method === 'tools/call') send({ jsonrpc: '2.0', id, error: { code: -32001, message: '403 Forbidden: you may not delete this contact' } });
  else if (method === 'tools/list') send({ jsonrpc: '2.0', id, result: { tools } });
  // Asked for a photo, it returns a picture with its text, the way a service with images does.
  else if (method === 'tools/call' && params.arguments?.photo) send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Alex, with a photo' }, { type: 'image', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', mimeType: 'image/png' }] } });
  else if (method === 'tools/call') send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `${params.name} ok ${JSON.stringify(params.arguments ?? {})}` }] } });
  else send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'no' } });
}
