import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { DATA_GENERATION, SessionStore } from '../src/session/store.js';

// Going back a version is safe because newer data only ever adds to older data. When it can't (a
// generation raised), an older polyphemus must stop before it writes anything, and say what to do.
describe('the data’s generation', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
  const dbPath = () => {
    const dir = mkdtempSync(join(tmpdir(), 'polyphemus-generation-'));
    dirs.push(dir);
    return join(dir, 'sessions.db');
  };

  it('is stamped on new data and on data from before it existed', () => {
    const path = dbPath();
    const old = new DatabaseSync(path);
    old.exec('CREATE TABLE kept (x)'); // data written before generations, stamped 0
    old.close();
    new SessionStore(path).close();
    const db = new DatabaseSync(path);
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(DATA_GENERATION);
    db.close();
  });

  it('stops an older polyphemus from opening data a newer one changed, touching nothing', () => {
    const path = dbPath();
    const newer = new DatabaseSync(path);
    newer.exec(`CREATE TABLE marker (x); PRAGMA user_version = ${DATA_GENERATION + 1}`);
    newer.close();
    expect(() => new SessionStore(path)).toThrow(/newer version of polyphemus changed this computer’s data/);
    const db = new DatabaseSync(path);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((t) => t.name);
    expect(tables).toEqual(['marker']);
    db.close();
  });
});
