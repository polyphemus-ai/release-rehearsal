import { describe, expect, it } from 'vitest';
import { serviceUnit } from '../src/service.js';

describe('serviceUnit', () => {
  it('runs poly serve with your PATH, restarts it on failure, and starts it with your user session', () => {
    const unit = serviceUnit({ node: '/usr/bin/node', launcher: '/opt/polyphemus/bin/polyphemus.mjs', cwd: '/home/me/projects', path: '/home/me/.local/bin:/usr/bin' });
    expect(unit).toContain('ExecStart="/usr/bin/node" "/opt/polyphemus/bin/polyphemus.mjs" serve');
    expect(unit).toContain('Environment="PATH=/home/me/.local/bin:/usr/bin"');
    expect(unit).toContain('WorkingDirectory=/home/me/projects');
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('WantedBy=default.target');
    expect(unit).not.toContain('POLYPHEMUS_PORT');
  });

  it('keeps a custom port and escapes systemd specifiers', () => {
    const unit = serviceUnit({ node: '/usr/bin/node', launcher: '/h/bin/polyphemus.mjs', cwd: '/h/100%', path: '/usr/bin', port: '4100' });
    expect(unit).toContain('Environment=POLYPHEMUS_PORT=4100');
    expect(unit).toContain('WorkingDirectory=/h/100%%');
  });
});

describe('launchdPlist', () => {
  it('runs poly serve at login on macOS, restarts it if it crashes, logs to a file, and escapes what XML needs', async () => {
    const { launchdPlist, LAUNCHD_LABEL } = await import('../src/service-manager.js');
    const plist = launchdPlist({ node: '/opt/homebrew/bin/node', launcher: '/usr/local/lib/node_modules/polyphemus/bin/polyphemus.mjs', cwd: '/Users/me/R&D <projects>', path: '/opt/homebrew/bin:/usr/bin', port: '4100', log: '/Users/me/Library/Logs/polyphemus/daemon.log' });
    expect(plist).toContain(`<string>${LAUNCHD_LABEL}</string>`);
    expect(plist).toContain('<string>/opt/homebrew/bin/node</string>\n    <string>/usr/local/lib/node_modules/polyphemus/bin/polyphemus.mjs</string>\n    <string>serve</string>');
    expect(plist).toContain('<string>/Users/me/R&amp;D &lt;projects&gt;</string>');
    expect(plist).toContain('<key>POLYPHEMUS_PORT</key>\n    <string>4100</string>');
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(plist).toMatch(/<key>SuccessfulExit<\/key>\s*<false\/>/);
    expect(plist).toContain('<key>StandardErrorPath</key>\n  <string>/Users/me/Library/Logs/polyphemus/daemon.log</string>');
  });

  it('says plainly where the background service doesn’t run', async () => {
    const { serviceManager } = await import('../src/service-manager.js');
    expect(() => serviceManager('win32')).toThrow(/Linux \(systemd\) and macOS \(launchd\).*WSL2/);
    expect(serviceManager('darwin').kind).toBe('launchd');
    expect(serviceManager('linux').kind).toBe('systemd');
  });
});
