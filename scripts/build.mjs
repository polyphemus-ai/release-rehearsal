#!/usr/bin/env node
// Builds the package that's published to npm, into dist/polyphemus: one bundle of the CLI, daemon and
// core (lib/main.mjs), each package's own files beside it, and a package.json whose dependencies are
// what the bundle leaves out. `node scripts/build.mjs --pack` also makes the tarball npm would publish.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist', 'polyphemus');
const read = (path) => JSON.parse(readFileSync(join(root, path), 'utf8'));

const workspace = ['packages/cli/package.json', 'packages/core/package.json', 'packages/daemon/package.json'].map(read);
const rootPkg = read('package.json');
const cli = workspace[0];
// Every npm dependency of the three packages, minus the workspace ones (they're bundled) and tsx
// (only the repository needs it).
const dependencies = Object.fromEntries(
  workspace
    .flatMap((pkg) => Object.entries(pkg.dependencies ?? {}))
    .filter(([name]) => !name.startsWith('@polyphemus/') && name !== 'tsx')
    .sort(([a], [b]) => a.localeCompare(b)),
);

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'lib'), { recursive: true });

await build({
  entryPoints: [join(root, 'packages/cli/src/main.ts')],
  outfile: join(out, 'lib', 'main.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22.13',
  external: Object.keys(dependencies),
  define: { POLYPHEMUS_BUNDLED: 'true' },
  // Some bundled code uses require(): give the ESM bundle one.
  banner: { js: "import { createRequire as __polyphemusRequire } from 'node:module';\nconst require = __polyphemusRequire(import.meta.url);" },
  legalComments: 'none',
  logLevel: 'warning',
});

const copy = (from, to) => cpSync(join(root, from), join(out, to), { recursive: true });
copy('packages/cli/bin/polyphemus.mjs', 'bin/polyphemus.mjs');
copy('packages/core/bin', 'core/bin');
copy('packages/core/templates', 'core/templates');
copy('packages/daemon/web', 'daemon/web');
copy('packages/daemon/security-headers.json', 'daemon/security-headers.json');
copy('README.md', 'README.md');
copy('LICENSE', 'LICENSE');
copy('NOTICE', 'NOTICE');

const pkg = {
  name: 'polyphemus-rehearsal',
  version: cli.version,
  description: 'A multi-provider agent harness: one agent loop over Claude, OpenAI and Grok — their APIs and their CLIs on your subscriptions — with projects, workflows, connections and a phone app.',
  license: 'Apache-2.0',
  homepage: 'https://polyphemus.ai',
  // Where it's built from: npm's trusted publishing ties a release's provenance to this repository.
  repository: { type: 'git', url: 'git+https://github.com/polyphemus-ai/release-rehearsal.git' },
  bugs: 'https://github.com/polyphemus-ai/release-rehearsal/issues',
  type: 'module',
  // What you type is `poly`; the full name works too, and so do the names it had before.
  bin: { poly: 'bin/polyphemus.mjs', polyphemus: 'bin/polyphemus.mjs' },
  engines: rootPkg.engines,
  files: ['bin', 'lib', 'core', 'daemon', 'README.md', 'LICENSE', 'NOTICE'],
  dependencies,
};
writeFileSync(join(out, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`Built polyphemus ${pkg.version} in ${out}`);

if (process.argv.includes('--pack')) {
  const packed = execFileSync('npm', ['pack', '--json', '--pack-destination', join(root, 'dist')], { cwd: out, encoding: 'utf8' });
  const [info] = JSON.parse(packed);
  console.log(`Packed ${info.filename}: ${info.files.length} files, ${Math.round(info.size / 1024)} KB`);
}
