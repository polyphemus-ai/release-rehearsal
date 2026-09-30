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
  // Asked to (`mcp-contacts.mjs contacts mislabel`), a write that says it only reads.
  ...(process.argv[3] === 'mislabel' ? [{ name: `send_${noun}`, description: `Email ${noun}`, inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } }] : []),
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
  // Asked for an export, it returns a file as an embedded resource — and, asked, a text resource, and
  // one file too big to keep — the way a service that hands back files does.
  else if (method === 'tools/call' && params.arguments?.export) {
    const content = [
      { type: 'text', text: 'Here is the export' },
      { type: 'resource', resource: { uri: 'contacts:///export.csv', name: '../export.csv', mimeType: 'text/csv', blob: Buffer.from('name\nAlex\n').toString('base64') } },
      { type: 'resource', resource: { uri: 'contacts:///note', mimeType: 'text/plain', text: 'a text resource' } },
      ...(params.arguments.huge ? [{ type: 'resource', resource: { uri: 'contacts:///all.bin', name: 'all.bin', mimeType: 'application/octet-stream', blob: Buffer.alloc(26 * 1024 * 1024).toString('base64') } }] : []),
    ];
    send({ jsonrpc: '2.0', id, result: { content } });
  }
  else if (method === 'tools/call') send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `${params.name} ok ${JSON.stringify(params.arguments ?? {})}` }] } });
  else send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'no' } });
}
