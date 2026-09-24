import { ConfigHistory, getConfigValue, PolyphemusError, lineDiff, parseConfig, parseValue, type Polyphemus } from '@polyphemus/core';
import { iso, printJson } from './output.js';
import { dim, green, red, yellow } from './render.js';

// `poly config …`: change settings safely instead of hand-editing config.toml
// (docs/design/cli-for-agents.md §4). Every change is validated, recorded, and can be undone.

/** Who's making the change, for the history. Agents can say who they are with POLYPHEMUS_CALLER. */
export const callerName = () => process.env.POLYPHEMUS_CALLER ?? (process.stdin.isTTY ? 'you (terminal)' : 'an agent or script');

const colorDiff = (lines: string[]) => lines.map((l) => (l.startsWith('+') ? green(l) : l.startsWith('-') ? red(l) : dim(l))).join('\n');
const restartNote = () => console.log(dim('The background service uses changed settings after: poly service restart'));

export function configCommand(polyphemus: Polyphemus, args: string[], flags: { dryRun: boolean }, json: boolean): void {
  const history = new ConfigHistory(polyphemus.home, polyphemus.store, callerName());
  const [action = 'get', key, ...valueParts] = args;
  switch (action) {
    case 'path':
      return json ? printJson({ path: history.file }) : console.log(history.file);
    case 'get': {
      const value = getConfigValue(history.read(), key);
      if (json) return printJson({ key: key ?? null, value });
      return console.log(value !== null && typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value));
    }
    case 'set':
    case 'unset': {
      if (!key) throw new PolyphemusError(`Usage: poly config ${action} <key>${action === 'set' ? ' <value>' : ''}`, 'USAGE', 'poly help config set');
      if (action === 'set' && valueParts.length === 0) throw new PolyphemusError(`What should ${key} be? poly config set ${key} <value>`, 'USAGE');
      const value = action === 'set' ? parseValue(valueParts.join(' ')) : undefined;
      const { before, after } = history.plan(key, value);
      const diff = lineDiff(before, after);
      if (flags.dryRun) {
        if (diff.length) process.exitCode = 10; // the dry run found changes
        return json ? printJson({ dryRun: true, changed: diff.length > 0, diff }) : console.log(diff.length ? colorDiff(diff) : dim('No change.'));
      }
      if (diff.length === 0) return json ? printJson({ changed: false }) : console.log(dim('Already set that way. Nothing changed.'));
      const rev = history.apply(after, action === 'set' ? `set ${key}` : `unset ${key}`);
      if (json) return printJson({ changed: true, revision: rev, diff });
      console.log(colorDiff(diff));
      console.log(`${green('✓')} Saved as revision ${rev}. Undo: poly config undo`);
      return restartNote();
    }
    case 'validate': {
      parseConfig(history.read(), history.file); // throws with the problem
      const drift = history.drift();
      if (json) return printJson({ valid: true, editedOutsidePolyphemus: drift !== undefined });
      console.log(`${green('✓')} config.toml is valid.`);
      if (drift) console.log(yellow(`It was edited outside polyphemus since revision ${drift.rev}. Keep it: poly config adopt · go back: poly config undo`));
      return;
    }
    case 'diff': {
      const rev = key === undefined ? undefined : Number(key);
      if (rev !== undefined && !Number.isInteger(rev)) throw new PolyphemusError('diff takes a revision number, like poly config diff 3.', 'USAGE');
      const base = rev === undefined ? history.latest() : polyphemus.store.configRevision(rev);
      if (!base) throw new PolyphemusError(rev === undefined ? 'There’s no history yet.' : `There's no revision ${rev}.`, 'NOT_FOUND', 'poly config history');
      const diff = lineDiff(base.content, history.read());
      if (json) return printJson({ against: base.rev, changed: diff.length > 0, diff });
      return console.log(diff.length ? `${dim(`Changes since revision ${base.rev}:`)}\n${colorDiff(diff)}` : dim(`No changes since revision ${base.rev}.`));
    }
    case 'history': {
      const revisions = polyphemus.store.configRevisions(30);
      if (json) return printJson({ revisions: revisions.map(({ content: _content, ...r }) => ({ ...r, at: iso(r.at) })) });
      if (revisions.length === 0) return console.log(dim('No history yet.'));
      for (const r of revisions) console.log(`${String(r.rev).padStart(4)}  ${dim(new Date(r.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}  ${r.action}  ${dim(`· ${r.caller}`)}`);
      return;
    }
    case 'undo': {
      const rev = history.undo();
      if (json) return printJson({ revision: rev });
      console.log(`${green('✓')} Undone. Saved as revision ${rev}.`);
      return restartNote();
    }
    case 'rollback': {
      const rev = Number(key);
      if (!Number.isInteger(rev)) throw new PolyphemusError('Usage: poly config rollback <revision>', 'USAGE', 'poly config history');
      const saved = history.rollback(rev);
      if (json) return printJson({ revision: saved });
      console.log(`${green('✓')} Back to revision ${rev}. Saved as revision ${saved}.`);
      return restartNote();
    }
    case 'adopt': {
      const rev = history.adopt();
      return json ? printJson({ revision: rev }) : console.log(`${green('✓')} Kept your edit as revision ${rev}.`);
    }
    default:
      throw new PolyphemusError(`Unknown config command "${action}". Try: get, set, unset, validate, diff, history, undo, rollback, adopt, path.`, 'USAGE', 'poly help config set');
  }
}
