#!/usr/bin/env node
// Installs the package exactly as npm would publish it into an empty folder, and checks it works
// there: the command runs, the daemon starts and serves the app with its security headers, polyphemus's
// own servers start, and the package holds only what it should. Run before any release.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const fail = (why) => {
  console.error(`✗ ${why}`);
  process.exit(1);
};
execFileSync('node', ['scripts/build.mjs', '--pack'], { cwd: root, stdio: 'inherit' });
const tarball = readdirSync(join(root, 'dist')).filter((f) => /^polyphemus-.*\.tgz$/.test(f)).map((f) => join(root, 'dist', f)).at(-1);
const listing = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).split('\n').filter(Boolean);
const unexpected = listing.filter((f) => !/^package\/(package\.json|README\.md|LICENSE|NOTICE|bin\/|lib\/|core\/(bin|templates)\/|daemon\/(web\/|security-headers\.json))/.test(f));
if (unexpected.length) fail(`the package holds files it shouldn't:\n  ${unexpected.join('\n  ')}`);

const dir = mkdtempSync(join(tmpdir(), 'polyphemus-pack-'));
const home = join(dir, 'home');
try {
  execFileSync('npm', ['init', '-y'], { cwd: dir, stdio: 'ignore' });
  execFileSync('npm', ['install', '--no-audit', '--no-fund', tarball], { cwd: dir, stdio: 'ignore' });
  const bin = join(dir, 'node_modules', '.bin', 'polyphemus');
  // Tailscale off: a throwaway daemon must never take the tailnet address a real one is using.
  const env = { ...process.env, POLYPHEMUS_HOME: home, POLYPHEMUS_PORT: '3981', POLYPHEMUS_TAILSCALE: 'off' };
  const version = execFileSync(bin, ['--version'], { env, encoding: 'utf8' }).trim();
  if (!/^\d+\.\d+\.\d+/.test(version)) fail(`--version said "${version}"`);
  const caps = JSON.parse(execFileSync(bin, ['capabilities', '--json'], { env, encoding: 'utf8' }));
  if (!caps.ok) fail('capabilities didn’t answer');

  // An installed copy knows it came from npm and asks it for a newer version (a stand-in registry here).
  // In its own process: this one blocks while the command runs.
  const registry = spawn(process.execPath, ['-e', "require('node:http').createServer((q, r) => r.end(JSON.stringify({ latest: '99.0.0' }))).listen(3982, '127.0.0.1', () => console.log('up'))"], { stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise((r) => registry.stdout.once('data', r));
  const update = JSON.parse(execFileSync(bin, ['update', '--check', '--json'], { env: { ...env, POLYPHEMUS_NPM_REGISTRY: 'http://127.0.0.1:3982' }, encoding: 'utf8' }));
  registry.kill();
  if (update.data?.installedFrom !== 'npm' || update.data?.newer !== true) fail(`the update check said ${JSON.stringify(update)}`);

  const daemon = spawn(bin, ['serve'], { env, stdio: 'ignore' });
  let served;
  for (let i = 0; i < 60 && !served; i++) {
    await new Promise((r) => setTimeout(r, 250));
    served = await fetch('http://127.0.0.1:3981/style.css').catch(() => undefined);
  }
  const page = await fetch('http://127.0.0.1:3981/').catch(() => undefined);
  daemon.kill('SIGTERM');
  if (served?.status !== 200) fail('the daemon didn’t serve the app');
  if (!page?.headers.get('content-security-policy')) fail('the daemon served the app without its security headers');

  const pkg = join(dir, 'node_modules', 'polyphemus');
  for (const server of readdirSync(join(pkg, 'core', 'bin')).filter((f) => f.endsWith('-mcp.mjs'))) {
    const answer = execFileSync(process.execPath, [join(pkg, 'core', 'bin', server), 'reviewer'], { input: `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`, encoding: 'utf8', timeout: 5000 }).split('\n')[0];
    if (!JSON.parse(answer).result) fail(`${server} didn’t start`);
  }
  if (!existsSync(join(pkg, 'core', 'templates'))) fail('templates are missing');
  if (!existsSync(join(pkg, 'LICENSE'))) fail('the license is missing');
  console.log(`✓ polyphemus ${version} installs from its tarball and runs: ${listing.length} files.`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
