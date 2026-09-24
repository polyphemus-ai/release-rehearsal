import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Polyphemus, type CliState } from '@polyphemus/core';
import { diagnose, type DoctorDeps } from '../src/doctor.js';

let polyphemus: Polyphemus;
const savedEnv = { ...process.env };

beforeEach(async () => {
  for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'XAI_API_KEY']) delete process.env[key];
  // A home with nothing in it: the configuration a new install writes for itself.
  polyphemus = await Polyphemus.open(await mkdtemp(join(tmpdir(), 'polyphemus-doctor-')));
});
afterEach(() => {
  polyphemus.close();
  process.env = { ...savedEnv };
});

/** A computer with nothing on it, which each test gives what it needs. */
const bare = (over: Partial<DoctorDeps> = {}): DoctorDeps => ({
  cli: async (adapter) => ({ installed: false, loginCommand: `${adapter.replace('-cli', '')} login` }),
  runtime: () => undefined,
  tailscale: async () => undefined,
  https: async () => undefined,
  chrome: () => undefined,
  daemon: async () => false,
  git: () => false,
  wsl: () => undefined,
  ...over,
});
const signedIn = (account: string): CliState => ({ installed: true, signedIn: true, account, loginCommand: 'x login' });
const run = (deps: DoctorDeps) => diagnose(polyphemus, { port: 3900, version: '0.1.0', deps });
const failing = (found: Awaited<ReturnType<typeof run>>) => found.filter((f) => f.state === 'fail').map((f) => f.what);

describe('poly doctor', () => {
  it('on a computer with nothing, names the two things that stop Polyphemus working, and what to do about each', async () => {
    const found = await run(bare());
    expect(failing(found)).toEqual(['Nothing here can run a model yet', 'Set to Isolated, but there’s no Docker or Podman here, so an agent can’t run a single command']);
    expect(found.find((f) => f.what.startsWith('Set to Isolated'))!.fix).toContain('or let agents run on this computer, as you: poly config set isolation.level host');
    // Three missing CLIs are one fact, with each one's sign-in.
    const clis = found.filter((f) => f.area === 'Models' && /Claude Code|Codex|Grok Build/.test(f.what));
    expect(clis.map((f) => f.what)).toEqual(['No Claude Code, Codex or Grok Build here']);
    expect(clis[0]!.fix!.join('\n')).toContain('codex login');
    // Everything else is worth a look, not a blocker.
    expect(found.find((f) => f.what === 'git isn’t installed, and projects and workflows need it')?.state).toBe('warn');
    expect(found.find((f) => f.what === '0.1.0, not running')?.fix).toEqual(['poly start — runs it in the background and opens setup in your browser']);
    expect(found.find((f) => f.what === 'No phone paired yet')?.fix).toEqual(['poly pair']);
  });

  it('on a computer with everything, has nothing to fix', async () => {
    const found = await run(
      bare({
        cli: async (adapter) => (adapter === 'claude-cli' ? signedIn('alex@example.com') : { installed: false }),
        runtime: () => ({ command: 'docker', name: 'Docker', version: '27.1.0', rootless: true }),
        tailscale: async () => ({ dnsName: 'laptop.example.ts.net.', ip: '100.64.0.1', local: true }),
        https: async () => 'https://laptop.example.ts.net',
        daemon: async () => true,
        git: () => true,
      }),
    );
    expect(failing(found)).toEqual([]);
    expect(found.map((f) => f.what)).toEqual(
      expect.arrayContaining(['Claude Code, signed in (alex@example.com)', 'Isolated, in Docker 27.1.0', 'Phones reach it at https://laptop.example.ts.net', 'Agents browse in Docker']),
    );
    // One CLI here and two not: those two are named each, since some are here.
    expect(found.filter((f) => f.what.endsWith('isn’t installed')).map((f) => f.what)).toEqual(['Codex isn’t installed', 'Grok Build isn’t installed']);
  });

  it('says a Codex that can’t run commands stops it, with the fix, and doesn’t count it as something to run on', async () => {
    const found = await run(
      bare({
        cli: async (adapter) =>
          adapter === 'codex-cli'
            ? {
                ...signedIn('ChatGPT'),
                sandbox: {
                  ok: false,
                  cause: 'apparmor',
                  checkedAt: 0,
                  explanation: { problem: 'Codex can’t run commands on this computer', why: 'AppArmor restricts user namespaces', fixes: [{ title: 'Allow bubblewrap', steps: ['sudo tee /etc/apparmor.d/bwrap'], tradeoff: '' }] },
                },
              }
            : { installed: false },
        runtime: () => ({ command: 'podman', name: 'Podman', version: '5.0.0', rootless: true }),
      }),
    );
    const codex = found.find((f) => f.what === 'Codex can’t run commands on this computer')!;
    expect(codex.state).toBe('fail');
    expect(codex.fix).toEqual(['AppArmor restricts user namespaces', 'Allow bubblewrap:', '  sudo tee /etc/apparmor.d/bwrap', 'The app shows every fix, on Codex’s card in Models & providers']);
    expect(failing(found)).toContain('Nothing here can run a model yet');
  });

  it('counts an API key as something to run on, and says a picked provider with no key can’t run', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    (polyphemus.config as { selected: string[] }).selected = ['openai:gpt-5'];
    const found = await run(bare({ runtime: () => ({ command: 'docker', name: 'Docker', version: '27.1.0', rootless: true }) }));
    expect(found.find((f) => f.what === 'anthropic: API key from ANTHROPIC_API_KEY')?.state).toBe('ok');
    expect(failing(found)).toEqual([expect.stringMatching(/^openai is picked but needs an API key/)]);
  });

  it('doesn’t call running agents on this computer a problem when that’s what was chosen', async () => {
    (polyphemus.config.isolation as { level: string }).level = 'host';
    const found = await run(bare({ cli: async () => signedIn('alex@example.com') }));
    expect(failing(found)).toEqual([]);
    expect(found.find((f) => f.area === 'Where agents run')?.what).toBe('On this computer: agents run as you, and reach what you can');
  });

  it('inside WSL without systemd, says how to turn it on', async () => {
    const found = await run(bare({ wsl: () => ({ systemd: false }) }));
    expect(found.find((f) => f.what.startsWith('WSL without systemd'))?.fix).toEqual(['sudo nano /etc/wsl.conf and add the lines [boot] and systemd=true', 'In Windows: wsl --shutdown, then open your Linux terminal again']);
    expect((await run(bare({ wsl: () => ({ systemd: true }) }))).find((f) => f.what === 'WSL, with systemd')?.state).toBe('ok');
  });

  it('inside WSL, points at Tailscale on Windows, and says HTTPS is the only way in from there', async () => {
    const found = await run(bare({ wsl: () => ({ systemd: true }) }));
    expect(found.find((f) => f.area === 'Phones' && f.state === 'warn')?.fix?.[0]).toMatch(/^Install Tailscale on Windows — not inside Linux/);
    const onWindows = await run(bare({ wsl: () => ({ systemd: true }), daemon: async () => true, tailscale: async () => ({ dnsName: 'pc.example.ts.net', ip: '100.64.0.2', local: false }) }));
    expect(onWindows.map((f) => f.what)).toContain('Tailscale is connected on Windows (pc.example.ts.net)');
    const noWay = onWindows.find((f) => f.what.startsWith('No HTTPS address'))!;
    expect(noWay.what).toBe('No HTTPS address, and from inside WSL that’s the only way a phone gets in');
    expect(noWay.fix).toContain('Or in PowerShell on Windows: tailscale serve --bg --https=443 http://127.0.0.1:3900');
  });
});
