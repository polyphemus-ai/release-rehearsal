import { writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, emptyUsage, Polyphemus, type Block, type ChatRequest, type ModelProvider, type ProviderEvent, type StopReason } from '@polyphemus/core';
import { startDaemon, type Daemon } from '../src/server.js';

// Artifacts in the thread (roadmap: show and connect, 1): an agent shows what it made; polyphemus keeps
// a copy, draws it where it was shown, serves it only to people who can see the thread, and runs an
// HTML one sandboxed.

const call = (name: string, input: Record<string, unknown>) => ({ content: [{ type: 'tool_call', id: `c${Math.random().toString(36).slice(2)}`, name, input }] as Block[], stopReason: 'tool_use' as StopReason });
const say = (text: string) => ({ content: [{ type: 'text', text }] as Block[], stopReason: 'end_turn' as StopReason });

class Scripted implements ModelProvider {
  readonly kind = 'model' as const;
  readonly id = 'openai';
  results: string[] = [];
  constructor(private steps: Array<{ content: Block[]; stopReason: StopReason }>) {}
  async *stream(req: ChatRequest): AsyncIterable<ProviderEvent> {
    const last = req.messages.at(-1);
    for (const b of last?.content ?? []) if (b.type === 'tool_result') this.results.push(String(b.content));
    const step = this.steps.shift() ?? say('done');
    yield { type: 'message_done', message: { role: 'assistant', content: step.content, origin: { provider: 'openai', model: req.model } }, stopReason: step.stopReason, usage: emptyUsage() };
  }
  async listModels() {
    return [];
  }
}

let home: string;
let polyphemus: Polyphemus;
let daemon: Daemon;
let base: string;
const savedEnv = { ...process.env };

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'polyphemus-artifacts-'));
  process.env.CODEX_HOME = join(home, 'no-codex');
  process.env.OPENAI_API_KEY = 'test-key';
  writeFileSync(join(home, 'config.toml'), `projects_root = ${JSON.stringify(join(home, 'projects'))}\ndefault_model = "gpt-api"\n${DEFAULT_CONFIG}\n[isolation]\nlevel = "host"\n`);
  polyphemus = await Polyphemus.open(home);
  daemon = await startDaemon({ polyphemus, hosts: ['127.0.0.1'], port: 0, cwd: home });
  base = daemon.urls[0]!;
});
afterEach(async () => {
  await daemon.close();
  polyphemus.close();
  process.env = { ...savedEnv };
});

async function device(personId?: string) {
  const cookie = (await fetch(`${base}/pair?code=${polyphemus.store.createPairingCode(undefined, personId)}`, { redirect: 'manual' })).headers.get('set-cookie')!.split(';')[0]!;
  const api = async (path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, data: (await res.json().catch(() => ({}))) as Record<string, any> };
  };
  return { cookie, api };
}

describe('artifacts', () => {
  it('shows what an agent made where it made it, to people who can see the thread, with HTML sandboxed', async () => {
    const owner = await device();
    const project = (await owner.api('/api/projects', { name: 'Stats' })).data.project;
    writeFileSync(join(project.path, 'plays.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>');
    writeFileSync(join(project.path, 'plays.html'), '<!doctype html><script>document.title = "chart"</script><div>chart</div>');
    const provider = new Scripted([
      call('show_artifact', { path: 'plays.svg', title: 'Plays per game' }),
      call('show_artifact', { path: 'plays.html', title: 'Plays, interactive' }),
      call('show_artifact', { path: join(homedir(), '.codex', 'auth.json') }),
      call('show_artifact', { path: 'missing.png' }),
      say('Here they are.'),
    ]);
    polyphemus.registry.use('openai', provider);
    const thread = (await owner.api('/api/sessions', { text: 'chart the plays', project: project.slug })).data;
    for (let i = 0; i < 100 && (await owner.api(`/api/sessions/${thread.id}`)).data.running; i++) await new Promise((r) => setTimeout(r, 30));

    const { artifacts, messages } = (await owner.api(`/api/sessions/${thread.id}`)).data;
    expect(artifacts.map((a: { title: string; kind: string }) => [a.title, a.kind])).toEqual([['Plays per game', 'svg'], ['Plays, interactive', 'html']]);
    // Placed where it was shown: after the reply that asked to show it.
    expect(artifacts[0].seq).toBeGreaterThan(0);
    expect(artifacts[0].seq).toBeLessThanOrEqual(messages.length);
    expect(provider.results[2]).toMatch(/credential|refus|block/i);
    expect(provider.results[3]).toContain('There’s no file');

    const svg = await fetch(`${base}/artifacts/${artifacts[0].id}/file`, { headers: { cookie: owner.cookie } });
    expect(svg.headers.get('content-type')).toBe('image/svg+xml');
    expect(svg.headers.get('content-security-policy')).toContain('sandbox');

    // HTML is only a sandboxed document of its own: scripts, but no network, no cookies, no polyphemus.
    expect((await fetch(`${base}/artifacts/${artifacts[1].id}/file`, { headers: { cookie: owner.cookie } })).status).toBe(404);
    const frame = await fetch(`${base}/artifacts/${artifacts[1].id}/frame`, { headers: { cookie: owner.cookie } });
    expect(frame.status).toBe(200);
    expect(frame.headers.get('content-security-policy')).toMatch(/^sandbox allow-scripts; default-src 'none'/);
    expect(frame.headers.get('content-security-policy')).not.toContain('allow-same-origin');
    expect(frame.headers.get('x-frame-options')).toBe('SAMEORIGIN');

    // Polyphemus's own copy: the thread still shows it after the file is gone.
    writeFileSync(join(project.path, 'plays.svg'), 'changed');
    expect(await (await fetch(`${base}/artifacts/${artifacts[0].id}/file`, { headers: { cookie: owner.cookie } })).text()).toContain('<rect');

    // Someone who can't see the thread can't see what's in it.
    const sam = polyphemus.store.addPerson('Sam');
    const samDevice = await device(sam.id);
    expect((await fetch(`${base}/artifacts/${artifacts[0].id}/file`, { headers: { cookie: samDevice.cookie } })).status).toBe(404);
    polyphemus.store.setProjectRole(project.slug, sam.id, 'viewer');
    expect((await fetch(`${base}/artifacts/${artifacts[0].id}/file`, { headers: { cookie: samDevice.cookie } })).status).toBe(200);

    // And the project keeps them together, so what was made is findable without remembering which
    // thread asked for it (2026-09-20). A workflow's pictures of its own pages are evidence on a
    // step, not something someone made, so they stay there.
    polyphemus.store.recordArtifact({ id: 'f'.repeat(16), sessionId: thread.id, seq: 9, title: '/ at 400px', kind: 'image', mediaType: 'image/png', name: 'page.png', bytes: 10, createdAt: Date.now(), by: 'workflow' });
    const made = (await owner.api(`/api/projects/${project.slug}/artifacts`)).data.artifacts;
    expect(made.map((a: { title: string; in: string }) => [a.title, a.in])).toEqual([
      ['Plays, interactive', 'chart the plays'],
      ['Plays per game', 'chart the plays'],
    ]);
    // A viewer sees what the project made; someone with no role sees no project at all.
    expect((await fetch(`${base}/api/projects/${project.slug}/artifacts`, { headers: { cookie: samDevice.cookie } })).status).toBe(200);
    polyphemus.store.setProjectRole(project.slug, sam.id, null);
    expect((await fetch(`${base}/api/projects/${project.slug}/artifacts`, { headers: { cookie: samDevice.cookie } })).status).toBe(404);
  });
});
