import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

// The real CLI, run the way an agent runs it: stdout is a pipe, so answers come back as JSON.

const LAUNCHER = fileURLToPath(new URL('../bin/polyphemus.mjs', import.meta.url));
let home: string;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'polyphemus-cli-'));
});

function polyphemus(...args: string[]): { status: number; json: any } {
  const env = { ...process.env, POLYPHEMUS_HOME: home, CODEX_HOME: join(home, 'no-codex'), POLYPHEMUS_OUTPUT: '' };
  try {
    const stdout = execFileSync(process.execPath, [LAUNCHER, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
    return { status: 0, json: JSON.parse(stdout) };
  } catch (err) {
    const failed = err as { status: number; stdout: string };
    return { status: failed.status, json: failed.stdout ? JSON.parse(failed.stdout) : undefined };
  }
}

describe('the CLI, as an agent sees it', () => {
  it('describes itself with capabilities', () => {
    const { status, json } = polyphemus('capabilities');
    expect(status).toBe(0);
    expect(json).toMatchObject({ ok: true, schemaVersion: 1, data: { name: 'polyphemus', paths: { home } } });
    expect(json.data.commands.map((c: { id: string }) => c.id)).toContain('sessions.show');
  }, 30_000);

  it('answers list commands in JSON when piped, and errors with a code and exit status', () => {
    expect(polyphemus('sessions')).toMatchObject({ status: 0, json: { ok: true, data: { sessions: [] } } });
    expect(polyphemus('sessions', 'show', 'nope')).toMatchObject({ status: 3, json: { ok: false, error: { code: 'NOT_FOUND', fix: 'poly sessions' } } });
    expect(polyphemus('help', 'sessions', 'show')).toMatchObject({ status: 0, json: { data: { id: 'sessions.show' } } });
    expect(polyphemus('--modle', 'x', '--json')).toMatchObject({ status: 2, json: { error: { code: 'USAGE' } } });
    expect(polyphemus('sesions').json).toMatchObject({ error: { code: 'USAGE', message: 'Unknown command "sesions". Did you mean "sessions"?' } });
  }, 60_000);
});
