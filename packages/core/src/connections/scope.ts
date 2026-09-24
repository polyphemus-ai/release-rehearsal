import { PolyphemusError } from '../types.js';

// Connections, ceilings and grants (docs/design/ui/settled-brief.md §5).
//
// A connection is an account at an outside service, reached through an MCP server that polyphemus runs
// or calls. What a grant can give is a set of that server's tools. Scope only narrows:
//
//   agent grant ⊆ project grant ⊆ ceiling ⊆ what the server offers
//
// and it's checked twice: when a grant is made (a wider one is refused, not trimmed), and at every
// call (so a grant narrowed or revoked mid-turn takes effect on the next call, whatever was offered).
//
// A grant can also go straight to an agent, with no project (project ''): the agent carries the
// connection wherever it works, including a thread with no project at all — a DM with it. That's the
// person's own choice about one agent, so its only bound is the ceiling. Inside a project an agent
// has whatever the project gives it and whatever it carries; the project's grant still can't be
// widened by an agent's narrowing of it.

export interface ConnectionTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  /** Only reads: the server said so (readOnlyHint), or its name does and the server didn't say otherwise. */
  reads: boolean;
}

export type Provenance = 'checked' | 'declared' | 'unknown';

/**
 * The most the credential permits, and how anyone knows.
 * - checked: the service told us (OAuth scopes in a response header), with when.
 * - declared: the owner said what they made the credential able to do — which tools, by whom, when.
 * - unknown: nobody has checked or declared; polyphemus holds itself to the grants but can't confirm the key is limited.
 */
export interface Ceiling {
  provenance: Provenance;
  /** The tools within the ceiling; undefined means everything the server offers. */
  tools?: string[];
  /** Who declared it (a person id), for declared. */
  by?: string;
  at?: number;
  /** What the service reported, for checked. */
  scopes?: string[];
}

export interface Grant {
  connection: string;
  /** Empty when the grant is the agent's own, carried wherever it works. */
  project: string;
  /** Empty for the project's own grant; an agent id for an agent's narrowing of it, or for one it carries. */
  agent: string;
  tools: string[];
  /** The person who granted it. */
  by: string;
  at: number;
}

/** Where a tool's reach comes from, in words the interface can show. */
export interface Reach {
  connection: string;
  tools: string[];
  /** The grant that decides it: the agent's own (carried or narrowing), or the project's that it inherits. */
  from: Grant;
  /** Set when the agent inherits: there's no grant of its own. */
  inherited: boolean;
  /** Set when some of it comes from a grant the agent carries, rather than from a project. */
  carried: boolean;
}

const READ_NAME = /^(get|list|read|search|find|fetch|query|describe|show|view|lookup|count)[_\-A-Z]|^(get|list|read|search)$/i;

export function readsOnly(tool: { name: string; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }): boolean {
  if (tool.annotations?.readOnlyHint !== undefined) return tool.annotations.readOnlyHint;
  if (tool.annotations?.destructiveHint) return false;
  return READ_NAME.test(tool.name);
}

/** The tools the ceiling allows, of those the server offers. */
export function ceilingTools(offered: readonly ConnectionTool[], ceiling: Ceiling): string[] {
  const names = offered.map((t) => t.name);
  return ceiling.tools ? names.filter((name) => ceiling.tools!.includes(name)) : names;
}

/**
 * Refuses a grant wider than what it narrows. A project grant must fit the ceiling; an agent's must
 * fit the project's. Refused with the tools that don't fit, never silently trimmed: someone asking
 * for write access should hear that they can't have it, not be handed read and left to find out.
 */
export function checkGrant(request: { tools: readonly string[]; agent: string; project: string }, ceiling: readonly string[], projectGrant: Grant | undefined): void {
  if (request.tools.length === 0) throw new PolyphemusError('A grant needs at least one tool. To take access away, revoke the grant.', 'USAGE');
  if (!request.project && !request.agent) throw new GrantRefused('A grant goes to a project, or to an agent that carries it.');
  const outsideCeiling = request.tools.filter((tool) => !ceiling.includes(tool));
  if (outsideCeiling.length > 0) {
    throw new GrantRefused(`${list(outsideCeiling)} ${outsideCeiling.length === 1 ? 'is' : 'are'} outside this connection’s ceiling, so no grant can include ${outsideCeiling.length === 1 ? 'it' : 'them'}.`);
  }
  // What an agent carries is between the person and that agent: the ceiling is the only bound.
  if (!request.agent || !request.project) return;
  if (!projectGrant) throw new GrantRefused(`This connection isn’t granted to ${request.project}, so nothing in it can be granted to an agent there.`);
  const outsideProject = request.tools.filter((tool) => !projectGrant.tools.includes(tool));
  if (outsideProject.length > 0) {
    throw new GrantRefused(`${list(outsideProject)} ${outsideProject.length === 1 ? 'isn’t' : 'aren’t'} in ${request.project}’s grant, and an agent’s grant can only narrow its project’s.`);
  }
}

/**
 * What an agent (or a thread with no agent) may call on a connection here, and why. It's what the
 * project grants (narrowed by the agent's own grant there, if it has one) plus what the agent
 * carries. Undefined: nothing — which is every connection in a thread with no project and an agent
 * carrying nothing.
 */
export function reachOf(offered: readonly ConnectionTool[], ceiling: Ceiling, grants: readonly Grant[], project: string | undefined, agent: string | undefined): Reach | undefined {
  const projectGrant = project ? grants.find((g) => g.project === project && g.agent === '') : undefined;
  const carried = agent ? grants.find((g) => g.project === '' && g.agent === agent) : undefined;
  if (!projectGrant && !carried) return undefined;
  const own = project && agent ? grants.find((g) => g.project === project && g.agent === agent) : undefined;
  const within = ceilingTools(offered, ceiling);
  const fromProject = projectGrant ? within.filter((tool) => projectGrant.tools.includes(tool) && (!own || own.tools.includes(tool))) : [];
  const fromAgent = carried ? within.filter((tool) => carried.tools.includes(tool)) : [];
  const allowed = [...new Set([...fromProject, ...fromAgent])];
  return {
    connection: (carried ?? projectGrant)!.connection,
    tools: allowed,
    // What it carries is its own, and says so first; then its narrowing here; then the project's.
    from: (fromAgent.length ? carried : undefined) ?? own ?? projectGrant ?? carried!,
    inherited: agent !== undefined && !own && !fromAgent.length,
    carried: fromAgent.length > 0,
  };
}

export class GrantRefused extends PolyphemusError {
  constructor(message: string) {
    super(message, 'USAGE');
  }
}

const list = (names: readonly string[]) => (names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);
