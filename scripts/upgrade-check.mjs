#!/usr/bin/env node
// Updating an installed polyphemus, end to end, with packages built from this checkout: installed by
// install/install.sh, updated by `poly update` from a stand-in npm registry, and rolled back. Three
// versions of this build: A (installed), B (a good update), and C, which can't read the data B
// leaves (its data generation is too old) — the update to C must be refused with nothing changed.
// Data is made with A and must survive every step. No service here (CI has none): the restart,
// health check and automatic going-back are tested with a stand-in service in the CLI's tests.
//
//   node scripts/upgrade-check.mjs
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const fail = (why) => {
  console.error(`✗ ${why}`);
  process.exit(1);
};
const ok = (what) => console.log(`✓ ${what}`);

execFileSync('node', ['scripts/build.mjs', '--pack'], { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] });
const built = readdirSync(join(root, 'dist')).filter((f) => /^polyphemus-.*\.tgz$/.test(f)).map((f) => join(root, 'dist', f)).at(-1);
const dir = mkdtempSync(join(tmpdir(), 'polyphemus-upgrade-'));
// The name the build publishes under (polyphemus, or a stand-in's), which is what poly update asks for.
const NAME = JSON.parse(execFileSync('tar', ['-xzOf', built, 'package/package.json'], { encoding: 'utf8' })).name;

// The three versions, from the one build.
const [A, B, C] = ['9.0.0', '9.0.1', '9.0.2'];
const tarballs = {};
for (const version of [A, B, C]) {
  const work = join(dir, `pkg-${version}`);
  mkdirSync(work);
  execFileSync('tar', ['-xzf', built, '-C', work]);
  const pkgFile = join(work, 'package', 'package.json');
  writeFileSync(pkgFile, JSON.stringify({ ...JSON.parse(readFileSync(pkgFile, 'utf8')), version }, null, 2));
  if (version === C) {
    const main = join(work, 'package', 'lib', 'main.mjs');
    const code = readFileSync(main, 'utf8');
    if (!/DATA_GENERATION = 1;/.test(code)) fail('the build has no DATA_GENERATION = 1 to break');
    writeFileSync(main, code.replace(/DATA_GENERATION = 1;/, 'DATA_GENERATION = 0;'));
  }
  const tgz = join(dir, `polyphemus-${version}.tgz`);
  execFileSync('tar', ['-czf', tgz, '-C', work, 'package']);
  tarballs[version] = tgz;
}

// A registry with just enough for npm install and polyphemus's update check, in a process of its own
// (this one blocks while npm runs). Everything but polyphemus is sent on to npm's own registry.
const latestFile = join(dir, 'latest');
const setLatest = (version) => writeFileSync(latestFile, version);
setLatest(A);
const manifests = Object.fromEntries(
  Object.entries(tarballs).map(([version, file]) => {
    const data = readFileSync(file);
    const manifest = JSON.parse(execFileSync('tar', ['-xzOf', file, 'package/package.json'], { encoding: 'utf8' }));
    return [version, { manifest, file, shasum: createHash('sha1').update(data).digest('hex'), integrity: `sha512-${createHash('sha512').update(data).digest('base64')}` }];
  }),
);
writeFileSync(join(dir, 'manifests.json'), JSON.stringify(manifests));
writeFileSync(
  join(dir, 'registry.mjs'),
  `import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
const [manifests, latestFile, name] = [JSON.parse(readFileSync(process.argv[2], 'utf8')), process.argv[3], process.argv[4]];
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const base = 'http://127.0.0.1:' + server.address().port;
  const latest = readFileSync(latestFile, 'utf8');
  if (url.pathname === '/-/package/' + name + '/dist-tags') return res.end(JSON.stringify({ latest }));
  if (url.pathname === '/' + name) {
    const versions = Object.fromEntries(Object.entries(manifests).map(([v, m]) => [v, { ...m.manifest, dist: { tarball: base + '/t/' + v + '.tgz', shasum: m.shasum, integrity: m.integrity } }]));
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ name, 'dist-tags': { latest }, versions }));
  }
  const tar = /^\\/t\\/(.+)\\.tgz$/.exec(url.pathname);
  if (tar && manifests[tar[1]]) return res.end(readFileSync(manifests[tar[1]].file));
  res.writeHead(302, { location: 'https://registry.npmjs.org' + req.url });
  res.end();
});
server.listen(0, '127.0.0.1', () => console.log(server.address().port));
`,
);
const server = spawn(process.execPath, [join(dir, 'registry.mjs'), join(dir, 'manifests.json'), latestFile, NAME], { stdio: ['ignore', 'pipe', 'inherit'] });
// Stopped however this ends (fail() exits straight away), or it holds the output open.
process.on('exit', () => server.kill());
const port = await new Promise((resolve) => server.stdout.once('data', (d) => resolve(String(d).trim())));
const registry = `http://127.0.0.1:${port}`;

const prefix = join(dir, 'prefix');
const bin = join(dir, 'bin');
const home = join(dir, 'home');
const env = { ...process.env, HOME: join(dir, 'user'), POLYPHEMUS_HOME: home, POLYPHEMUS_PREFIX: prefix, POLYPHEMUS_BIN_DIR: bin, POLYPHEMUS_CLIS: 'none', POLYPHEMUS_TAILSCALE: 'off', POLYPHEMUS_NPM_REGISTRY: registry, NO_COLOR: '1' };
mkdirSync(env.HOME);
const poly = (args, input) => spawnSync(join(bin, 'poly'), args, { env, encoding: 'utf8', input, timeout: 240_000 });
const current = () => readlinkSync(join(prefix, 'current'));
const version = () => poly(['--version']).stdout.trim();

try {
  // A, installed as a person would, and some data made with it.
  const installed = spawnSync('sh', [join(root, 'install', 'install.sh')], { env: { ...env, POLYPHEMUS_PACKAGE: tarballs[A] }, encoding: 'utf8' });
  if (installed.status !== 0) fail(`install.sh: ${installed.stdout}${installed.stderr}`);
  if (current() !== `versions/${A}` || version() !== A) fail(`after installing, current is ${current()} and poly says ${version()}`);
  ok(`${A} installed into versions/${A}, with current pointing at it`);
  const again = spawnSync('sh', [join(root, 'install', 'install.sh')], { env, encoding: 'utf8' });
  if (again.status !== 0 || !again.stdout.includes('already installed') || current() !== `versions/${A}`) fail(`running the installer again changed something: ${again.stdout}${again.stderr}`);
  ok('running the installer again leaves an installed polyphemus alone, and says how to update');
  if (poly(['secrets', 'set', 'test/example', '--kind', 'token'], 'not-a-real-value').status !== 0) fail('couldn’t add a secret');
  if (poly(['config', 'set', 'updates.check', 'false']).status !== 0) fail('couldn’t change a setting');
  const data = () => ({
    secret: poly(['secrets', 'ls', '--json']).stdout.includes('test/example'),
    setting: readFileSync(join(home, 'config.toml'), 'utf8').includes('check = false'),
    history: poly(['config', 'history', '--json']).stdout.includes('updates.check'),
  });
  const kept = (when) => {
    const d = data();
    if (!d.secret || !d.setting || !d.history) fail(`${when}, some data was lost: ${JSON.stringify(d)}`);
  };
  kept('before updating');

  // A → B: installed beside A, checked, backed up, switched.
  setLatest(B);
  const toB = poly(['update']);
  if (toB.status !== 0) fail(`poly update to ${B}: ${toB.stdout}${toB.stderr}`);
  if (current() !== `versions/${B}` || version() !== B) fail(`after updating, current is ${current()} and poly says ${version()}`);
  if (!existsSync(join(prefix, 'versions', A))) fail(`${A} wasn’t kept for going back`);
  if (!readdirSync(join(home, 'backups')).some((d) => d.endsWith(`before-${B}`))) fail('no backup was made before updating');
  if (readdirSync(join(home, 'cache')).some((d) => d.startsWith('self-check-'))) fail('the self-check left its copy of the data behind');
  kept(`after updating to ${B}`);
  ok(`${A} → ${B}: installed beside it, checked against a copy of the data, backed up, switched; data kept`);

  // B → C, which can't read B's data: refused before anything changed.
  setLatest(C);
  const toC = poly(['update']);
  if (toC.status === 0) fail(`the update to ${C}, which can’t read the data, went ahead: ${toC.stdout}`);
  if (!/couldn’t work with your data, so nothing was changed/.test(toC.stdout + toC.stderr)) fail(`the refusal didn’t say why: ${toC.stdout}${toC.stderr}`);
  if (current() !== `versions/${B}` || version() !== B) fail(`after the refused update, current is ${current()} and poly says ${version()}`);
  if (existsSync(join(prefix, 'versions', C))) fail(`the refused ${C} was left installed`);
  kept(`after the refused update to ${C}`);
  ok(`${B} → ${C} (can’t read the data): refused by its self-check, nothing changed`);

  // Back to A by hand.
  const back = poly(['rollback']);
  if (back.status !== 0) fail(`poly rollback: ${back.stdout}${back.stderr}`);
  if (current() !== `versions/${A}` || version() !== A) fail(`after rolling back, current is ${current()} and poly says ${version()}`);
  kept('after rolling back');
  ok(`poly rollback: back on ${A}, data kept`);
} finally {
  server.kill();
  rmSync(dir, { recursive: true, force: true });
}
