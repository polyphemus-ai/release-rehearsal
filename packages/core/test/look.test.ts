import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findChrome, openBrowser } from '../src/browser/chrome.js';
import type { NodeContext, WorkflowNode } from '../src/workflows/define.js';
import { findPreview, startPreview } from '../src/workflows/preview.js';
import { shipIssueWorkflow } from '../src/workflows/ship.js';

// Looking at what a workflow built: serving a site from its folder, and a headless browser that opens
// its pages and says what went wrong on them.

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'polyphemus-look-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('finding and serving a site', () => {
  it('finds what serves it from the repository: a script with its package manager, or plain HTML', () => {
    expect(findPreview(dir)).toBeUndefined();
    writeFileSync(join(dir, 'index.html'), '<h1>Hi</h1>');
    expect(findPreview(dir)).toEqual({ from: 'the HTML files' });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { build: 'astro build', dev: 'astro dev' } }));
    writeFileSync(join(dir, 'pnpm-lock.yaml'), '');
    expect(findPreview(dir)).toEqual({ command: 'pnpm dev', from: 'package.json (pnpm)' });
  });

  it('serves plain files from the folder only: nothing above it, nothing in .git', async () => {
    writeFileSync(join(dir, 'index.html'), '<h1>Home</h1>');
    writeFileSync(join(dir, 'about.html'), '<h1>About</h1>');
    mkdirSync(join(dir, '.git'));
    writeFileSync(join(dir, '.git', 'config'), 'secret');
    const preview = await startPreview({ dir });
    try {
      expect(await (await fetch(`${preview.url}/`)).text()).toBe('<h1>Home</h1>');
      expect(await (await fetch(`${preview.url}/about`)).text()).toBe('<h1>About</h1>');
      expect((await fetch(`${preview.url}/.git/config`)).status).toBe(404);
      expect((await fetch(`${preview.url}/%2e%2e/%2e%2e/etc/passwd`)).status).toBe(404);
    } finally {
      await preview.stop();
    }
  });

  it('runs a project’s command with a port, looks at that port, and stops everything it started', async () => {
    // Like a dev server: it starts a child that listens, and prints where.
    writeFileSync(join(dir, 'serve.mjs'), `import { createServer } from 'node:http'; const s = createServer((q, r) => r.end('dev ' + process.env.PORT)).listen(Number(process.env.PORT) + 0, '127.0.0.1', () => console.log('  Local:   http://localhost:' + s.address().port + '/'));`);
    writeFileSync(join(dir, 'grandchild.sh'), `node serve.mjs & echo $! > child.pid; wait`);
    const preview = await startPreview({ dir, command: 'bash grandchild.sh' });
    const body = await (await fetch(`${preview.url}/`)).text();
    // The port polyphemus handed it, whatever address the command prints for a person to click.
    expect(preview.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(body).toBe(`dev ${preview.url.split(':').at(-1)}`);
    const pid = Number(execFileSync('cat', [join(dir, 'child.pid')]).toString());
    expect(alive(pid)).toBe(true);
    await preview.stop();
    expect(alive(pid)).toBe(false);
  });

  it('says what the command printed when it stops before the site answers', async () => {
    await expect(startPreview({ dir, command: 'echo "Cannot find module astro"; exit 3' })).rejects.toThrow(/stopped \(exit 3\) before the site answered:\nCannot find module astro/);
  });
});

describe.skipIf(!findChrome())('looking at pages', () => {
  it('takes a whole-page picture at a width and colour scheme, and reports errors, missing files and error pages', async () => {
    writeFileSync(join(dir, 'index.html'), `<title>Home</title><style>@media (prefers-color-scheme: dark) { body { background: #000 } }</style><p>${'word '.repeat(4000)}</p><img src="/gone.png"><script>console.error('bad thing'); setTimeout(() => { throw new Error('late') }, 20)</script>`);
    writeFileSync(join(dir, 'ok.html'), '<title>Fine</title><h1>Fine</h1>');
    const preview = await startPreview({ dir });
    const browser = await openBrowser();
    try {
      const home = await browser.look(`${preview.url}/`, { width: 400, scheme: 'dark' });
      expect(home).toMatchObject({ status: 200, title: 'Home', width: 400, scheme: 'dark' });
      expect(home.problems).toEqual(expect.arrayContaining([`404 for ${preview.url}/gone.png`, 'Console error: bad thing', 'Uncaught: Error: late']));
      // Taller than the window: the whole page.
      expect(home.png!.readUInt32BE(16)).toBe(400);
      expect(home.png!.readUInt32BE(20)).toBeGreaterThan(2000);
      const fine = await browser.look(`${preview.url}/ok`, { width: 1280 });
      expect(fine).toMatchObject({ status: 200, title: 'Fine', problems: [] });
      expect(fine.png!.readUInt32BE(16)).toBe(1280);
      const missing = await browser.look(`${preview.url}/nope`, { width: 400 });
      expect(missing.problems[0]).toMatch(/404/);
    } finally {
      await browser.close();
      await preview.stop();
    }
  }, 60_000);
});

describe('the look in ship-issue', () => {
  const look = (shipIssueWorkflow.nodes.find((n) => n.kind === 'loop') as Extract<WorkflowNode, { kind: 'loop' }>).body.find((n) => n.id === 'look') as Extract<WorkflowNode, { kind: 'check' }>;
  const ctx = (artifacts: Record<string, unknown>) => ({ runId: 'r', input: {}, artifacts: { worktree: { path: dir }, ...artifacts }, checks: {}, cwd: dir, home: dir, services: {} }) as unknown as NodeContext;

  it('looks at nothing when the plan names no pages, and says so', async () => {
    expect(await look.probe!(ctx({ plan: { pages: [] }, 'find-checks': { preview: null } }))).toEqual({ results: [], note: 'Nothing to look at: the plan names no pages.' });
  });

  it('never runs a serve command nobody was shown: one that appeared or changed since fails instead', async () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'touch ran.txt' } }));
    const appeared = await look.probe!(ctx({ plan: { pages: ['/'] }, 'find-checks': { preview: null } }));
    expect(appeared.results[0]).toMatchObject({ ok: false, output: expect.stringContaining('served with `npm run dev` now, which nobody allowed.') });
    const changed = await look.probe!(ctx({ plan: { pages: ['/'] }, 'find-checks': { preview: { command: 'npm start', from: 'package.json (npm)' } } }));
    expect(changed.results[0]).toMatchObject({ ok: false, output: expect.stringContaining('(they allowed `npm start`)') });
    expect(() => execFileSync('test', ['-e', join(dir, 'ran.txt')])).toThrow();
  });
});
