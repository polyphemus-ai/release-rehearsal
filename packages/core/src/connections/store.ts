import type { DatabaseSync } from 'node:sqlite';
import type { McpServerDefinition } from './mcp-client.js';
import type { Ceiling, ConnectionTool, Grant } from './scope.js';
import { SignInStore } from './sign-ins.js';

// Where connections, their grants and what they did are kept. Secrets are not: a definition holds
// `secret:connection/<id>/<name>` references, and the values live in the vault.

export type ConnectionHealth = 'untested' | 'ok' | 'failing';

export interface Connection {
  /** A slug, stable for life: it's in tool names and deep links. */
  id: string;
  name: string;
  /** The person who owns the account, and who is asked to fix it when it fails. */
  owner: string;
  server: McpServerDefinition;
  /** What the server offers, as it last listed it. */
  tools: ConnectionTool[];
  toolsListedAt?: number;
  ceiling: Ceiling;
  health: ConnectionHealth;
  /** When health was last established, by a test or a call. */
  healthAt?: number;
  /** The actual error, when failing. */
  error?: string;
  /** auth: reconnecting fixes it; unavailable: the server or the way to it is down. */
  errorKind?: 'auth' | 'unavailable' | 'protocol';
  /** The thread a failing call was part of, so the card can say what broke. */
  errorSession?: string;
  createdAt: number;
  /** Who added it. */
  createdBy: string;
}

export interface ConnectionActivity {
  id: number;
  connection: string;
  at: number;
  tool: string;
  outcome: 'ok' | 'refused' | 'failed';
  detail?: string;
  /** The work it was part of. */
  sessionId?: string;
  agent?: string;
  /** Who sent the turn: person:<id> or routine:<id>. */
  actor?: string;
}

export const CONNECTION_SCHEMA = `
-- Accounts at outside services, reached through MCP servers (settled brief §5).
CREATE TABLE IF NOT EXISTS connections (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  owner           TEXT NOT NULL,          -- person id
  server          TEXT NOT NULL,          -- JSON McpServerDefinition, secrets as references only
  tools           TEXT NOT NULL DEFAULT '[]',
  tools_listed_at INTEGER,
  ceiling         TEXT NOT NULL,          -- JSON Ceiling: provenance, tools, by, at, scopes
  health          TEXT NOT NULL DEFAULT 'untested',
  health_at       INTEGER,
  error           TEXT,
  error_kind      TEXT,
  error_session   TEXT,
  created_at      INTEGER NOT NULL,
  created_by      TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS connection_grants (
  connection TEXT NOT NULL,
  project    TEXT NOT NULL,
  agent      TEXT NOT NULL DEFAULT '',    -- '' is the project's grant; an agent id narrows it
  tools      TEXT NOT NULL,               -- JSON array of tool names
  granted_by TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  PRIMARY KEY (connection, project, agent)
);
-- Every call polyphemus made or refused, and the work it was part of. Kept after a disconnect.
CREATE TABLE IF NOT EXISTS connection_activity (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  connection TEXT NOT NULL,
  at         INTEGER NOT NULL,
  tool       TEXT NOT NULL,
  outcome    TEXT NOT NULL,               -- ok | refused | failed
  detail     TEXT,
  session_id TEXT,
  agent      TEXT,
  actor      TEXT
);
CREATE INDEX IF NOT EXISTS connection_activity_by_time ON connection_activity(connection, at DESC);
`;

interface ConnectionRow {
  id: string;
  name: string;
  owner: string;
  server: string;
  tools: string;
  tools_listed_at: number | null;
  ceiling: string;
  health: ConnectionHealth;
  health_at: number | null;
  error: string | null;
  error_kind: Connection['errorKind'] | null;
  error_session: string | null;
  created_at: number;
  created_by: string;
}

const toConnection = (r: ConnectionRow): Connection => ({
  id: r.id,
  name: r.name,
  owner: r.owner,
  server: JSON.parse(r.server),
  tools: JSON.parse(r.tools),
  ...(r.tools_listed_at !== null && { toolsListedAt: r.tools_listed_at }),
  ceiling: JSON.parse(r.ceiling),
  health: r.health,
  ...(r.health_at !== null && { healthAt: r.health_at }),
  ...(r.error !== null && { error: r.error }),
  ...(r.error_kind !== null && { errorKind: r.error_kind }),
  ...(r.error_session !== null && { errorSession: r.error_session }),
  createdAt: r.created_at,
  createdBy: r.created_by,
});

export class ConnectionStore {
  /** Sign-ins the Browser connection keeps. */
  readonly signIns: SignInStore;

  constructor(private readonly db: DatabaseSync) {
    db.exec(CONNECTION_SCHEMA);
    this.signIns = new SignInStore(db);
  }

  list(): Connection[] {
    return (this.db.prepare('SELECT * FROM connections ORDER BY name COLLATE NOCASE').all() as unknown as ConnectionRow[]).map(toConnection);
  }

  get(id: string): Connection | undefined {
    const row = this.db.prepare('SELECT * FROM connections WHERE id = ?').get(id) as ConnectionRow | undefined;
    return row && toConnection(row);
  }

  add(c: Pick<Connection, 'id' | 'name' | 'owner' | 'server' | 'ceiling' | 'createdBy'>, at = Date.now()): Connection {
    this.db
      .prepare('INSERT INTO connections (id, name, owner, server, ceiling, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(c.id, c.name, c.owner, JSON.stringify(c.server), JSON.stringify(c.ceiling), at, c.createdBy);
    return this.get(c.id)!;
  }

  setServer(id: string, server: Connection['server']): void {
    this.db.prepare('UPDATE connections SET server = ? WHERE id = ?').run(JSON.stringify(server), id);
  }

  setOwner(id: string, owner: string): void {
    this.db.prepare('UPDATE connections SET owner = ? WHERE id = ?').run(owner, id);
  }

  setTools(id: string, tools: ConnectionTool[], at = Date.now()): void {
    this.db.prepare('UPDATE connections SET tools = ?, tools_listed_at = ? WHERE id = ?').run(JSON.stringify(tools), at, id);
  }

  setCeiling(id: string, ceiling: Ceiling): void {
    this.db.prepare('UPDATE connections SET ceiling = ? WHERE id = ?').run(JSON.stringify(ceiling), id);
    // Grants never outlast the ceiling they were cut from.
    if (ceiling.tools) for (const grant of this.grants(id)) this.trim(grant, ceiling.tools);
  }

  /** Records whether it works. Returns true when that changed, so the caller can tell people. */
  setHealth(id: string, health: ConnectionHealth, failure?: { error: string; kind: NonNullable<Connection['errorKind']>; sessionId?: string }, at = Date.now()): boolean {
    const before = this.get(id);
    this.db
      .prepare('UPDATE connections SET health = ?, health_at = ?, error = ?, error_kind = ?, error_session = ? WHERE id = ?')
      .run(health, at, failure?.error ?? null, failure?.kind ?? null, failure?.sessionId ?? null, id);
    return before !== undefined && (before.health !== health || before.error !== failure?.error || before.errorSession !== failure?.sessionId);
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM connection_grants WHERE connection = ?').run(id);
    this.signIns.removeAll(id);
    this.db.prepare('DELETE FROM connections WHERE id = ?').run(id);
  }

  grants(connection?: string): Grant[] {
    const rows = (connection
      ? this.db.prepare('SELECT * FROM connection_grants WHERE connection = ? ORDER BY project, agent').all(connection)
      : this.db.prepare('SELECT * FROM connection_grants ORDER BY connection, project, agent').all()) as unknown as Array<{
      connection: string;
      project: string;
      agent: string;
      tools: string;
      granted_by: string;
      granted_at: number;
    }>;
    return rows.map((r) => ({ connection: r.connection, project: r.project, agent: r.agent, tools: JSON.parse(r.tools), by: r.granted_by, at: r.granted_at }));
  }

  /** Saves a grant that has already been checked (scope.checkGrant). Narrowing a project's grant narrows its agents' too. */
  setGrant(grant: Grant): void {
    this.db
      .prepare(
        `INSERT INTO connection_grants (connection, project, agent, tools, granted_by, granted_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (connection, project, agent) DO UPDATE SET tools = excluded.tools, granted_by = excluded.granted_by, granted_at = excluded.granted_at`,
      )
      .run(grant.connection, grant.project, grant.agent, JSON.stringify(grant.tools), grant.by, grant.at);
    if (grant.agent === '') {
      for (const agentGrant of this.grants(grant.connection).filter((g) => g.project === grant.project && g.agent !== '')) this.trim(agentGrant, grant.tools);
    }
  }

  /** Takes a grant away. Revoking a project's grant takes its agents' with it. */
  revokeGrant(connection: string, project: string, agent = ''): boolean {
    const result =
      agent === ''
        ? this.db.prepare('DELETE FROM connection_grants WHERE connection = ? AND project = ?').run(connection, project)
        : this.db.prepare('DELETE FROM connection_grants WHERE connection = ? AND project = ? AND agent = ?').run(connection, project, agent);
    return Number(result.changes) > 0;
  }

  private trim(grant: Grant, within: readonly string[]): void {
    const tools = grant.tools.filter((tool) => within.includes(tool));
    if (tools.length === grant.tools.length) return;
    if (tools.length === 0) this.revokeGrant(grant.connection, grant.project, grant.agent);
    else this.db.prepare('UPDATE connection_grants SET tools = ? WHERE connection = ? AND project = ? AND agent = ?').run(JSON.stringify(tools), grant.connection, grant.project, grant.agent);
  }

  record(entry: Omit<ConnectionActivity, 'id' | 'at'>, at = Date.now()): void {
    this.db
      .prepare('INSERT INTO connection_activity (connection, at, tool, outcome, detail, session_id, agent, actor) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(entry.connection, at, entry.tool, entry.outcome, entry.detail ?? null, entry.sessionId ?? null, entry.agent ?? null, entry.actor ?? null);
  }

  activity(connection: string, limit = 50): ConnectionActivity[] {
    const rows = this.db.prepare('SELECT * FROM connection_activity WHERE connection = ? ORDER BY at DESC, id DESC LIMIT ?').all(connection, limit) as unknown as Array<{
      id: number;
      connection: string;
      at: number;
      tool: string;
      outcome: ConnectionActivity['outcome'];
      detail: string | null;
      session_id: string | null;
      agent: string | null;
      actor: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      connection: r.connection,
      at: r.at,
      tool: r.tool,
      outcome: r.outcome,
      ...(r.detail !== null && { detail: r.detail }),
      ...(r.session_id !== null && { sessionId: r.session_id }),
      ...(r.agent !== null && { agent: r.agent }),
      ...(r.actor !== null && { actor: r.actor }),
    }));
  }
}
