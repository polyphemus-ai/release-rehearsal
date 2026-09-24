#!/usr/bin/env node
// Polyphemus's own MCP server for Google Drive and Gmail (read-only). It's handed a one-hour access
// token in ACCESS_TOKEN when it starts — never the refresh token or the client secret — and polyphemus
// restarts it with a fresh one before that runs out. Usage: google-mcp.mjs drive|gmail
import { createInterface } from 'node:readline';

const service = process.argv[2];
const token = process.env.ACCESS_TOKEN;
const base = (process.env.GOOGLE_API ?? 'https://www.googleapis.com').replace(/\/$/, '');
const MAX_TEXT = 40_000;

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const clip = (text) => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n\n[… ${text.length - MAX_TEXT} more characters]` : text);
const object = (properties, required = []) => ({ type: 'object', properties, required });

class GoogleError extends Error {}

async function google(path, { text = false } = {}) {
  const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
  if (res.status === 401 || res.status === 403) {
    const detail = await res.text().catch(() => '');
    throw new GoogleError(`${res.status} ${res.status === 401 ? 'Unauthorized' : 'Forbidden'}: Google refused the request${/insufficient|scope/i.test(detail) ? ' (the sign-in doesn’t include this permission)' : ''}.`);
  }
  if (!res.ok) throw new GoogleError(`Google answered ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
  return text ? res.text() : res.json();
}

// ── Drive ──

const DRIVE_FIELDS = 'files(id,name,mimeType,modifiedTime,size,webViewLink,owners(displayName))';
const quote = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const describeFile = (f) => ({ id: f.id, name: f.name, type: f.mimeType, modified: f.modifiedTime, size: f.size ? Number(f.size) : undefined, link: f.webViewLink, owner: f.owners?.[0]?.displayName });
const EXPORTS = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain',
  'application/vnd.google-apps.drawing': 'image/svg+xml',
};

const driveTools = {
  search_files: {
    description: 'Search Google Drive. `text` searches names and contents; `name` matches names only. Newest first.',
    inputSchema: object({ text: { type: 'string' }, name: { type: 'string' }, max: { type: 'number' } }),
    run: async ({ text, name, max }) => {
      const q = ['trashed = false', text ? `fullText contains ${quote(text)}` : null, name ? `name contains ${quote(name)}` : null].filter(Boolean).join(' and ');
      const pageSize = Math.min(Math.max(Number(max) || 20, 1), 50);
      const params = new URLSearchParams({ q, pageSize: String(pageSize), fields: DRIVE_FIELDS, ...(text ? {} : { orderBy: 'modifiedTime desc' }) });
      const { files = [] } = await google(`/drive/v3/files?${params}`);
      return JSON.stringify(files.map(describeFile), null, 2);
    },
  },
  recent_files: {
    description: 'The files in Google Drive changed most recently.',
    inputSchema: object({ max: { type: 'number' } }),
    run: async ({ max }) => {
      const params = new URLSearchParams({ q: 'trashed = false', orderBy: 'modifiedTime desc', pageSize: String(Math.min(Math.max(Number(max) || 20, 1), 50)), fields: DRIVE_FIELDS });
      const { files = [] } = await google(`/drive/v3/files?${params}`);
      return JSON.stringify(files.map(describeFile), null, 2);
    },
  },
  read_file: {
    description: 'Read a Drive file by id, as text: Docs and Slides as plain text, Sheets as CSV, text files as they are.',
    inputSchema: object({ id: { type: 'string' } }, ['id']),
    run: async ({ id }) => {
      if (!id) throw new GoogleError('Give the file’s id (from search_files).');
      const file = await google(`/drive/v3/files/${encodeURIComponent(id)}?fields=id,name,mimeType,size`);
      const as = EXPORTS[file.mimeType];
      if (as) return `# ${file.name}\n\n${clip(await google(`/drive/v3/files/${encodeURIComponent(id)}/export?mimeType=${encodeURIComponent(as)}`, { text: true }))}`;
      const readable = /^text\/|json|csv|xml|yaml|markdown|javascript/.test(file.mimeType ?? '');
      if (!readable) return `${file.name} is ${file.mimeType}, which can’t be read as text.`;
      return `# ${file.name}\n\n${clip(await google(`/drive/v3/files/${encodeURIComponent(id)}?alt=media`, { text: true }))}`;
    },
  },
};

// ── Gmail ──

const header = (message, name) => message.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
const decode = (data) => Buffer.from(String(data).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
function bodyText(part) {
  if (!part) return '';
  if (part.mimeType === 'text/plain' && part.body?.data) return decode(part.body.data);
  for (const child of part.parts ?? []) {
    const text = bodyText(child);
    if (text) return text;
  }
  if (part.mimeType === 'text/html' && part.body?.data) return decode(part.body.data).replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n');
  return '';
}

const gmailTools = {
  search_messages: {
    description: 'Search Gmail with Gmail’s own search syntax (from:, subject:, newer_than:7d, is:unread …). Returns sender, subject, date and a snippet.',
    inputSchema: object({ query: { type: 'string' }, max: { type: 'number' } }),
    run: async ({ query, max }) => {
      const params = new URLSearchParams({ maxResults: String(Math.min(Math.max(Number(max) || 10, 1), 25)), ...(query ? { q: query } : {}) });
      const { messages = [] } = await google(`/gmail/v1/users/me/messages?${params}`);
      const found = await Promise.all(
        messages.map(async ({ id }) => {
          const m = await google(`/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`);
          return { id: m.id, thread: m.threadId, from: header(m, 'From'), subject: header(m, 'Subject'), date: header(m, 'Date'), snippet: m.snippet, labels: m.labelIds };
        }),
      );
      return JSON.stringify(found, null, 2);
    },
  },
  read_message: {
    description: 'Read one Gmail message by id: its headers and its text.',
    inputSchema: object({ id: { type: 'string' } }, ['id']),
    run: async ({ id }) => {
      if (!id) throw new GoogleError('Give the message’s id (from search_messages).');
      const m = await google(`/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=full`);
      const lines = ['From', 'To', 'Cc', 'Date', 'Subject'].map((name) => (header(m, name) ? `${name}: ${header(m, name)}` : null)).filter(Boolean);
      return `${lines.join('\n')}\n\n${clip(bodyText(m.payload).trim() || m.snippet || '')}`;
    },
  },
  list_labels: {
    description: 'The labels in this Gmail account.',
    inputSchema: object({}),
    run: async () => {
      const { labels = [] } = await google('/gmail/v1/users/me/labels');
      return JSON.stringify(labels.map((l) => ({ id: l.id, name: l.name, type: l.type })), null, 2);
    },
  },
};

const tools = service === 'drive' ? driveTools : service === 'gmail' ? gmailTools : {};

for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    continue;
  }
  const { id, method, params } = message;
  if (id === undefined) continue;
  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: `polyphemus-google-${service}`, version: '0.1.0' } } });
  } else if (!token) {
    send({ jsonrpc: '2.0', id, error: { code: -32001, message: '401 Unauthorized: not signed in to Google.' } });
  } else if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: Object.entries(tools).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema, annotations: { readOnlyHint: true } })) } });
  } else if (method === 'tools/call') {
    const tool = tools[params?.name];
    if (!tool) {
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `No tool called ${params?.name}.` }], isError: true } });
      continue;
    }
    try {
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: await tool.run(params.arguments ?? {}) }] } });
    } catch (err) {
      // A refused token is a JSON-RPC error, so polyphemus sees it as the connection's problem, not the model's.
      if (/^40[13]\b/.test(err.message)) send({ jsonrpc: '2.0', id, error: { code: -32001, message: err.message } });
      else send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: err.message }], isError: true } });
    }
  } else if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} });
  } else {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}
