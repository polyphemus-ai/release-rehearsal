import { describe, expect, it } from 'vitest';
import { isReadOnlyCommand } from '../src/tools/readonly.js';

// The checks a morning brief makes: are the services up, what's on the remote. None change anything.
describe('read-only service and remote checks', () => {
  it('lets service queries, logs, and remote listings run without asking', () => {
    expect(isReadOnlyCommand('systemctl --user is-active bg-local-app.service')).toBe(true);
    expect(isReadOnlyCommand('systemctl --user list-units --state=failed --no-legend | head')).toBe(true);
    expect(isReadOnlyCommand('systemctl --user status polyphemus --no-pager')).toBe(true);
    expect(isReadOnlyCommand('journalctl --user -u polyphemus -n 50 --no-pager')).toBe(true);
    expect(isReadOnlyCommand('git ls-remote --heads origin main 2>&1 | head -2')).toBe(true);
  });

  it('still asks before anything that changes services, logs, or could send data out', () => {
    expect(isReadOnlyCommand('systemctl --user restart polyphemus')).toBe(false);
    expect(isReadOnlyCommand('systemctl --user stop bg-local-app')).toBe(false);
    expect(isReadOnlyCommand('systemctl --user')).toBe(false);
    expect(isReadOnlyCommand('journalctl --vacuum-time=1d')).toBe(false);
    expect(isReadOnlyCommand("curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3800/")).toBe(false);
    expect(isReadOnlyCommand('wget -qO- https://example.com')).toBe(false);
  });
});
