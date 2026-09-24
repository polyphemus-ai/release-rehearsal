import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const LAUNCHER = fileURLToPath(new URL('../bin/polyphemus.mjs', import.meta.url));

describe('stopping the daemon', () => {
  // A service manager stops a service by signalling every process in it: the launcher and the
  // daemon it runs, at once, and the launcher passes the signal on — so the daemon hears it twice.
  // The second used to kill it halfway through closing, and the service stopped as failed with its
  // database left open, on every stop and every deploy (2026-09-22).
  it('shuts down cleanly when its whole process group is told to stop, as systemd does', async () => {
    const home = await mkdtemp(join(tmpdir(), 'polyphemus-stop-'));
    const daemon = spawn(process.execPath, [LAUNCHER, 'serve'], {
      env: { ...process.env, POLYPHEMUS_HOME: home, POLYPHEMUS_TAILSCALE: 'off', POLYPHEMUS_PORT: '0', POLYPHEMUS_CONTAINER_RUNTIME: 'off' },
      detached: true, // a process group of its own, like a service's
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    daemon.stdout.on('data', (c: Buffer) => (out += c.toString()));
    daemon.stderr.on('data', (c: Buffer) => (out += c.toString()));
    for (let i = 0; i < 300 && !out.includes('listening on'); i++) await new Promise((r) => setTimeout(r, 100));
    expect(out).toContain('listening on');

    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => daemon.on('exit', (code, signal) => resolve({ code, signal })));
    process.kill(-daemon.pid!, 'SIGTERM');
    expect(await exited).toEqual({ code: 0, signal: null });
    expect(out).toContain('Stopped.');
  }, 60_000);
});
