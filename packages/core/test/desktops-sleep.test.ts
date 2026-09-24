import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Desktops } from '../src/isolation/desktop.js';
import type { EgressProxy } from '../src/isolation/egress.js';
import type { ContainerRuntime } from '../src/isolation/runtime.js';

describe('agents’ computers when polyphemus stops or starts', () => {
  it('puts every one of this install’s running computers to sleep, and nothing else', async () => {
    // A computer that outlived its daemon kept its 2 GB with nothing to put it to sleep (2026-09-19).
    const dir = await mkdtemp(join(tmpdir(), 'desktops-sleep-'));
    const log = join(dir, 'calls.log');
    const command = join(dir, 'docker');
    await writeFile(command, `#!/bin/sh\necho "$*" >> ${log}\n[ "$1" = ps ] && printf 'helm\\nscout\\n'\nexit 0\n`);
    await chmod(command, 0o755);
    const runtime: ContainerRuntime = { command, name: 'Docker', version: '27', rootless: false } as ContainerRuntime;
    const egress = { scope: 'scope1', forget: () => {} } as unknown as EgressProxy;
    const desktops = new Desktops(dir, () => runtime, egress);
    try {
      expect(await desktops.sleepAll()).toBe(2);
      const calls = (await readFile(log, 'utf8')).trim().split('\n');
      // Only this install's: the listing is filtered to its scope.
      expect(calls[0]).toContain('label=polyphemus.scope=scope1');
      expect(calls.filter((c) => c.startsWith('stop -t 5 polyphemus-d-'))).toHaveLength(2);
      expect(calls.filter((c) => c.startsWith('rm -f polyphemus-d-'))).toHaveLength(2);
      // No container runtime: nothing to do, and no error.
      expect(await new Desktops(dir, () => undefined, egress).sleepAll()).toBe(0);
    } finally {
      desktops.close();
    }
  });
});
