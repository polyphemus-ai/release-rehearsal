import { DEFAULT_CONFIG } from '../src/config.js';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CodexAgent } from '../src/agents/codex-cli.js';
import { codexSandbox, forgetCodexSandbox, probeCodexSandbox } from '../src/agents/codex-sandbox.js';
import { resolveModel } from '../src/config.js';
import { Polyphemus } from '../src/polyphemus.js';

// What the Codex CLI (0.154) prints on Ubuntu 24.04 with kernel.apparmor_restrict_unprivileged_userns = 1,
// captured 2026-09-16 from `codex sandbox -- true` (exit 1), and what `codex exec` streams for a reply.
const BWRAP_FAILURE = 'bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted';

let dir: string;
const savedEnv = { ...process.env };
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'polyphemus-sandbox-'));
  forgetCodexSandbox();
});
afterEach(() => {
  process.env = { ...savedEnv };
});

let fakes = 0;
/** A stand-in `codex`: `sandbox -- true` passes or fails as told; `exec` streams one short reply. */
async function fakeCodex(sandbox: 'passes' | 'fails' | 'unknown-subcommand'): Promise<string> {
  const file = join(dir, `codex-${sandbox}-${++fakes}`);
  await writeFile(
    file,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
require('node:fs').appendFileSync(__filename + '.args', JSON.stringify(args) + '\\n');
if (args[0] === 'sandbox') {
  ${
    sandbox === 'passes'
      ? 'process.exit(0);'
      : sandbox === 'fails'
        ? `process.stderr.write(${JSON.stringify(`${BWRAP_FAILURE}\n`)}); process.exit(1);`
        : `process.stderr.write("error: unrecognized subcommand 'sandbox'\\n\\nUsage: codex [OPTIONS] [PROMPT]\\n"); process.exit(2);`
  }
}
if (args[0] === 'exec') {
  process.stdin.resume();
  process.stdin.on('end', () => {
    const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
    out({ type: 'thread.started', thread_id: 'th_1' });
    out({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'done' } });
    out({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 2 } });
  });
}
`,
  );
  await chmod(file, 0o755);
  return file;
}

describe("Codex's sandbox on this computer", () => {
  it('passes when a command runs through it', async () => {
    const check = await probeCodexSandbox(await fakeCodex('passes'), { platform: 'linux', setting: () => '1' });
    // The restriction being on doesn't matter when the sandbox works (an AppArmor profile for bwrap, say).
    expect(check).toMatchObject({ ok: true });
    expect(check?.explanation).toBeUndefined();
  });

  it('fails the way Ubuntu’s AppArmor restriction makes it fail, and says why and what to do', async () => {
    const check = await probeCodexSandbox(await fakeCodex('fails'), { platform: 'linux', setting: (path) => (path === 'kernel/apparmor_restrict_unprivileged_userns' ? '1' : undefined), exists: () => true });
    expect(check).toMatchObject({ ok: false, cause: 'apparmor', output: BWRAP_FAILURE });
    expect(check?.explanation?.problem).toContain('every command Codex runs fails before it starts');
    expect(check?.explanation?.why).toContain('kernel.apparmor_restrict_unprivileged_userns = 1');
    const [narrow, broad] = check!.explanation!.fixes;
    expect(narrow?.steps.join('\n')).toContain('profile bwrap /usr/bin/bwrap flags=(unconfined)');
    expect(narrow?.steps.join('\n')).toContain('apparmor_parser -r /etc/apparmor.d/bwrap');
    expect(broad?.steps[0]).toBe('sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0');
    expect(broad?.tradeoff).toMatch(/every program/);
  });

  it('names kernel settings that turn namespaces off, and claims no cause it can’t see', async () => {
    const codex = await fakeCodex('fails');
    expect(await probeCodexSandbox(codex, { platform: 'linux', setting: (path) => (path === 'user/max_user_namespaces' ? '0' : undefined) })).toMatchObject({ ok: false, cause: 'userns-disabled' });
    const unknown = await probeCodexSandbox(codex, { platform: 'linux', setting: () => undefined });
    expect(unknown?.cause).toBeUndefined();
    expect(unknown?.explanation?.why).toContain(BWRAP_FAILURE);
    // A failure that isn't about namespaces isn't the sandbox's: nothing is said.
    const run = async () => ({ code: 1, output: 'Error: failed to load config.toml' });
    expect(await probeCodexSandbox('codex', { platform: 'linux', run, setting: () => '1' })).toBeUndefined();
  });

  it('doesn’t check where Codex doesn’t use bubblewrap, or where Codex isn’t installed', async () => {
    const calls: string[] = [];
    const run = async (command: string) => (calls.push(command), { code: 1, output: BWRAP_FAILURE });
    expect(await probeCodexSandbox('codex', { platform: 'darwin', run })).toBeUndefined();
    expect(await probeCodexSandbox('codex', { platform: 'win32', run })).toBeUndefined();
    expect(calls).toEqual([]);
    expect(await probeCodexSandbox(join(dir, 'no-such-codex'), { platform: 'linux' })).toBeUndefined();
  });

  it('checks the namespaces directly with a Codex too old to have `codex sandbox`', async () => {
    const calls: string[][] = [];
    const run = async (command: string, args: string[]) => {
      calls.push([command, ...args]);
      return command === 'unshare' ? { code: 1, output: 'unshare: write failed /proc/self/uid_map: Operation not permitted' } : { code: 2, output: "error: unrecognized subcommand 'sandbox'\n\nUsage: codex" };
    };
    expect(await probeCodexSandbox('codex', { platform: 'linux', run, setting: () => '1' })).toMatchObject({ ok: false, cause: 'apparmor' });
    expect(calls[1]).toEqual(['unshare', '--user', '--map-root-user', '--net', 'true']);
    // …and a real old binary reaches the same fallback.
    const passing = async (command: string, args: string[]) => (command === 'unshare' ? { code: 0, output: '' } : { code: 2, output: "error: unrecognized subcommand 'sandbox'\n\nUsage: codex" });
    expect(await probeCodexSandbox(await fakeCodex('unknown-subcommand'), { platform: 'linux', run: passing })).toMatchObject({ ok: true });
  });

  it('remembers an answer for a while', async () => {
    let runs = 0;
    const run = async () => (runs++, { code: 0, output: '' });
    await codexSandbox('codex-remembered', { platform: 'linux', run });
    await codexSandbox('codex-remembered', { platform: 'linux', run });
    expect(runs).toBe(1);
    forgetCodexSandbox();
    await codexSandbox('codex-remembered', { platform: 'linux', run });
    expect(runs).toBe(2);
  });
});

describe('a Codex turn on a computer where its sandbox can’t start', () => {
  const turn = async (sandbox: 'passes' | 'fails', opts: { sandboxOff?: boolean } = {}) => {
    const home = await mkdtemp(join(tmpdir(), 'polyphemus-sandbox-home-'));
    // Tests of how things run on this computer: the level a fresh install wouldn't default to.
    await writeFile(join(home, 'config.toml'), `${DEFAULT_CONFIG}\n[isolation]\nlevel = "host"\n`);
    process.env.CODEX_HOME = join(home, 'no-codex');
    const polyphemus = await Polyphemus.open(home);
    const command = await fakeCodex(sandbox);
    polyphemus.registry.use('codex', new CodexAgent('codex', { command, ...(opts.sandboxOff && { sandbox: false }) }));
    const checked: string[] = [];
    polyphemus.sandboxCheck = (cmd) => (checked.push(cmd), probeCodexSandbox(cmd, { platform: 'linux', setting: () => '1' }));
    const session = polyphemus.newSession({ cwd: home, model: resolveModel(polyphemus.config, 'codex') });
    const notices: string[] = [];
    session.on((event) => event.type === 'notice' && notices.push(event.text));
    return { polyphemus, session, notices, checked, command };
  };

  it('says so in the thread once, from polyphemus’s own check', async () => {
    const { session, notices, checked, command } = await turn('fails');
    expect(await session.send('list the files')).toBe('end_turn');
    expect(await session.send('and again')).toBe('end_turn');
    expect(checked[0]).toBe(command);
    const said = notices.filter((n) => n.includes('sandbox'));
    expect(said).toHaveLength(1);
    expect(said[0]).toBe(
      'codex can’t run commands on this computer: Codex’s sandbox (bubblewrap) can’t start, so every command it tries fails before it runs. This Linux restricts unprivileged user namespaces through AppArmor (kernel.apparmor_restrict_unprivileged_userns = 1), and the sandbox needs them. The fix is a setting on this computer for you to change: Models & providers shows how, on Codex’s card, where you can also choose to run Codex without its sandbox. Until then, pick another model for work that needs commands.',
    );
  });

  it('runs Codex without its sandbox only when the owner turned it off, says so, and keeps read-only work sandboxed', async () => {
    const { readFile } = await import('node:fs/promises');
    const sandboxFlag = async (command: string) =>
      (await readFile(`${command}.args`, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as string[]).filter((a) => a[0] === 'exec').map((a) => a[a.indexOf('--sandbox') + 1]);

    const normal = await turn('passes');
    await normal.session.send('list the files');
    expect(await sandboxFlag(normal.command)).toEqual(['workspace-write']);

    const off = await turn('fails', { sandboxOff: true });
    await off.session.send('list the files');
    await off.session.send('and again');
    expect(await sandboxFlag(off.command)).toEqual(['danger-full-access', 'danger-full-access']);
    // It doesn't check a sandbox it isn't using, and it says once that the commands have full permissions.
    expect(off.checked).toEqual([]);
    expect(off.notices.filter((n) => n.includes('sandbox'))).toEqual(['codex runs without its sandbox on this computer, as the owner set in Models & providers: the commands it runs have the owner\'s full permissions and aren\'t asked about first.']);

    // Read-only work keeps its sandbox: nothing else would make it read-only.
    const reading = await turn('fails', { sandboxOff: true });
    reading.session.readOnly = true;
    await reading.session.send('review this');
    expect(await sandboxFlag(reading.command)).toEqual(['read-only']);
    expect(reading.notices.filter((n) => n.includes('sandbox'))).toHaveLength(1);
    expect(reading.notices[0]).toContain('can’t run commands on this computer');
  });

  it('says nothing when the sandbox works, or when the turn runs without it', async () => {
    const ok = await turn('passes');
    await ok.session.send('list the files');
    expect(ok.notices.filter((n) => n.includes('sandbox'))).toEqual([]);

    const bypassed = await turn('fails');
    bypassed.session.autoApprove = true;
    await bypassed.session.send('list the files');
    expect(bypassed.checked).toEqual([]);
    expect(bypassed.notices.filter((n) => n.includes('sandbox'))).toEqual([]);
  });
});

