#!/usr/bin/env node
// Polyphemus's own MCP server for a GitHub identity (planner, builder or reviewer). It's handed an
// installation token that lasts an hour in ACCESS_TOKEN — never the app's private key — and polyphemus
// restarts it with a fresh one. There is no merge tool, for any role: merging is something a workflow
// does itself, after checking who approved which commit. Usage: github-mcp.mjs planner|builder|reviewer
import { createInterface } from 'node:readline';

const role = process.argv[2];
const token = process.env.ACCESS_TOKEN;
const base = (process.env.GITHUB_API ?? 'https://api.github.com').replace(/\/$/, '');
const MAX_TEXT = 40_000;

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const clip = (text) => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n\n[… ${text.length - MAX_TEXT} more characters]` : text);
const object = (properties, required = []) => ({ type: 'object', properties, required });
const repoArg = { type: 'string', description: 'owner/name' };

class GitHubError extends Error {}

async function gh(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', ...(body && { 'content-type': 'application/json' }) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (res.status === 401) throw new GitHubError(`401 Unauthorized: GitHub refused the token.`);
  if (!res.ok) throw new GitHubError(`GitHub answered ${res.status}: ${data.message ?? text.slice(0, 200)}`);
  return data;
}

const repoPath = (repo) => {
  if (!/^[\w.-]+\/[\w.-]+$/.test(String(repo ?? ''))) throw new GitHubError('Give the repository as owner/name.');
  return `/repos/${repo}`;
};
const brief = (issue) => ({ number: issue.number, title: issue.title, state: issue.state, labels: (issue.labels ?? []).map((l) => l.name ?? l), author: issue.user?.login, url: issue.html_url, updated: issue.updated_at });

const reads = {
  list_repositories: {
    description: 'The repositories this identity is installed on.',
    inputSchema: object({}),
    run: async () => JSON.stringify(((await gh('/installation/repositories?per_page=100')).repositories ?? []).map((r) => ({ repo: r.full_name, default_branch: r.default_branch, private: r.private })), null, 2),
  },
  list_issues: {
    description: 'Issues in a repository (not pull requests), newest first.',
    inputSchema: object({ repo: repoArg, state: { type: 'string', enum: ['open', 'closed', 'all'] }, labels: { type: 'string', description: 'comma-separated' } }, ['repo']),
    run: async ({ repo, state, labels }) => {
      const params = new URLSearchParams({ state: state ?? 'open', per_page: '30', ...(labels ? { labels } : {}) });
      const issues = await gh(`${repoPath(repo)}/issues?${params}`);
      return JSON.stringify(issues.filter((i) => !i.pull_request).map(brief), null, 2);
    },
  },
  get_issue: {
    description: 'One issue with its comments.',
    inputSchema: object({ repo: repoArg, number: { type: 'number' } }, ['repo', 'number']),
    run: async ({ repo, number }) => {
      const issue = await gh(`${repoPath(repo)}/issues/${Number(number)}`);
      const comments = await gh(`${repoPath(repo)}/issues/${Number(number)}/comments?per_page=50`);
      return clip(`# #${issue.number} ${issue.title} (${issue.state})\nLabels: ${(issue.labels ?? []).map((l) => l.name).join(', ') || 'none'}\n\n${issue.body ?? ''}\n\n${comments.map((c) => `— ${c.user?.login}: ${c.body}`).join('\n\n')}`);
    },
  },
  list_pull_requests: {
    description: 'Pull requests in a repository.',
    inputSchema: object({ repo: repoArg, state: { type: 'string', enum: ['open', 'closed', 'all'] } }, ['repo']),
    run: async ({ repo, state }) => JSON.stringify((await gh(`${repoPath(repo)}/pulls?state=${state ?? 'open'}&per_page=30`)).map((p) => ({ ...brief(p), head: p.head?.ref, head_sha: p.head?.sha, base: p.base?.ref, draft: p.draft })), null, 2),
  },
  get_pull_request: {
    description: 'One pull request: its head commit, the files it changes, its reviews (with the commit each was for) and its checks.',
    inputSchema: object({ repo: repoArg, number: { type: 'number' } }, ['repo', 'number']),
    run: async ({ repo, number }) => {
      const pr = await gh(`${repoPath(repo)}/pulls/${Number(number)}`);
      const [files, reviews, checks] = await Promise.all([
        gh(`${repoPath(repo)}/pulls/${Number(number)}/files?per_page=100`),
        gh(`${repoPath(repo)}/pulls/${Number(number)}/reviews?per_page=100`),
        gh(`${repoPath(repo)}/commits/${pr.head.sha}/check-runs?per_page=100`).catch(() => ({ check_runs: [] })),
      ]);
      return clip(
        JSON.stringify(
          {
            number: pr.number,
            title: pr.title,
            state: pr.state,
            merged: pr.merged,
            author: pr.user?.login,
            head: pr.head.ref,
            head_sha: pr.head.sha,
            base: pr.base.ref,
            body: pr.body,
            files: files.map((f) => ({ path: f.filename, status: f.status, additions: f.additions, deletions: f.deletions })),
            reviews: reviews.map((r) => ({ by: r.user?.login, state: r.state, commit: r.commit_id, stale: r.commit_id !== pr.head.sha })),
            checks: (checks.check_runs ?? []).map((c) => ({ name: c.name, status: c.status, conclusion: c.conclusion })),
          },
          null,
          2,
        ),
      );
    },
  },
  get_checks: {
    description: 'Check runs and statuses for a commit or branch.',
    inputSchema: object({ repo: repoArg, ref: { type: 'string' } }, ['repo', 'ref']),
    run: async ({ repo, ref }) => {
      const [runs, status] = await Promise.all([gh(`${repoPath(repo)}/commits/${encodeURIComponent(ref)}/check-runs?per_page=100`), gh(`${repoPath(repo)}/commits/${encodeURIComponent(ref)}/status`)]);
      return JSON.stringify({ state: status.state, sha: status.sha, checks: (runs.check_runs ?? []).map((c) => ({ name: c.name, status: c.status, conclusion: c.conclusion })) }, null, 2);
    },
  },
  read_file: {
    description: 'A file’s text at a branch or commit.',
    inputSchema: object({ repo: repoArg, path: { type: 'string' }, ref: { type: 'string' } }, ['repo', 'path']),
    run: async ({ repo, path, ref }) => {
      const file = await gh(`${repoPath(repo)}/contents/${String(path).split('/').map(encodeURIComponent).join('/')}${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`);
      if (Array.isArray(file)) return JSON.stringify(file.map((f) => ({ path: f.path, type: f.type })), null, 2);
      return clip(Buffer.from(file.content ?? '', 'base64').toString('utf8'));
    },
  },
};

const writes = {
  create_issue: {
    description: 'Open an issue.',
    inputSchema: object({ repo: repoArg, title: { type: 'string' }, body: { type: 'string' }, labels: { type: 'array', items: { type: 'string' } } }, ['repo', 'title']),
    run: async ({ repo, title, body, labels }) => JSON.stringify(brief(await gh(`${repoPath(repo)}/issues`, { method: 'POST', body: { title, body, labels } })), null, 2),
  },
  comment: {
    description: 'Comment on an issue or pull request.',
    inputSchema: object({ repo: repoArg, number: { type: 'number' }, body: { type: 'string' } }, ['repo', 'number', 'body']),
    run: async ({ repo, number, body }) => {
      const c = await gh(`${repoPath(repo)}/issues/${Number(number)}/comments`, { method: 'POST', body: { body } });
      return `Commented: ${c.html_url}`;
    },
  },
  create_pull_request: {
    description: 'Open a pull request from a branch you pushed.',
    inputSchema: object({ repo: repoArg, head: { type: 'string' }, base: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, draft: { type: 'boolean' } }, ['repo', 'head', 'base', 'title']),
    run: async ({ repo, head, base: into, title, body, draft }) => {
      const pr = await gh(`${repoPath(repo)}/pulls`, { method: 'POST', body: { head, base: into, title, body, draft: draft === true } });
      return JSON.stringify({ number: pr.number, url: pr.html_url, head_sha: pr.head?.sha }, null, 2);
    },
  },
  review_pull_request: {
    description: 'Review a pull request at a specific commit: APPROVE, REQUEST_CHANGES or COMMENT. An approval is for that commit only; a new commit makes it stale.',
    inputSchema: object({ repo: repoArg, number: { type: 'number' }, commit: { type: 'string', description: 'The head commit you reviewed (from get_pull_request).' }, event: { type: 'string', enum: ['APPROVE', 'REQUEST_CHANGES', 'COMMENT'] }, body: { type: 'string' } }, ['repo', 'number', 'commit', 'event']),
    run: async ({ repo, number, commit, event, body }) => {
      const pr = await gh(`${repoPath(repo)}/pulls/${Number(number)}`);
      if (pr.head.sha !== commit) throw new GitHubError(`The pull request has moved on: its head is ${pr.head.sha.slice(0, 7)}, not ${String(commit).slice(0, 7)}. Review what's there now.`);
      const review = await gh(`${repoPath(repo)}/pulls/${Number(number)}/reviews`, { method: 'POST', body: { commit_id: commit, event, body: body ?? '' } });
      return `Reviewed (${review.state}) at ${String(commit).slice(0, 7)}: ${review.html_url ?? ''}`;
    },
  },
};

// What each role is offered. GitHub's permissions enforce it too; this keeps a role from trying.
const byRole = {
  planner: { ...reads, create_issue: writes.create_issue, comment: writes.comment, create_pull_request: writes.create_pull_request },
  builder: { ...reads, comment: writes.comment, create_pull_request: writes.create_pull_request },
  reviewer: { ...reads, comment: writes.comment, review_pull_request: writes.review_pull_request },
};
const tools = byRole[role] ?? reads;

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
    send({ jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: `polyphemus-github-${role}`, version: '0.1.0' } } });
  } else if (!token) {
    send({ jsonrpc: '2.0', id, error: { code: -32001, message: '401 Unauthorized: this GitHub identity isn’t installed yet.' } });
  } else if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: Object.entries(tools).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema, annotations: { readOnlyHint: name in reads } })) } });
  } else if (method === 'tools/call') {
    const tool = tools[params?.name];
    if (!tool) {
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `No tool called ${params?.name} for the ${role}.` }], isError: true } });
      continue;
    }
    try {
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: await tool.run(params.arguments ?? {}) }] } });
    } catch (err) {
      if (/^401\b/.test(err.message)) send({ jsonrpc: '2.0', id, error: { code: -32001, message: err.message } });
      else send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: err.message }], isError: true } });
    }
  } else if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} });
  } else {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}
