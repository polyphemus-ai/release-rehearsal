import type { Person, ProjectRole, SessionMeta, SessionStore } from '@polyphemus/core';

// Who may see and do what (docs/design/ui/settled-brief.md §7). One place, asked by every route, the
// event stream and push, so a permission is never enforced in one path and forgotten in another.
//
// - The install owner — whose computer this is — sees and does everything. The interface says so
//   rather than implying a privacy boundary the filesystem doesn't have.
// - Everyone else is a member or viewer of particular projects, and membership of one grants
//   nothing anywhere else. A member works, messages and approves there; a viewer reads.
// - A thread belongs to its project. A thread with no project belongs to whoever started it.

export class Access {
  private roles?: Map<string, ProjectRole>;

  constructor(
    private readonly store: SessionStore,
    readonly person: Person,
  ) {}

  get owner(): boolean {
    return this.person.owner;
  }

  get actor(): string {
    return `person:${this.person.id}`;
  }

  /** This person's role in a project, or undefined when they don't belong to it. */
  role(project: string): ProjectRole | 'owner' | undefined {
    if (this.owner) return 'owner';
    this.roles ??= this.store.projectRoles(this.person.id);
    return this.roles.get(project);
  }

  /** Any project where this person can do more than read. */
  get worksAnywhere(): boolean {
    if (this.owner) return true;
    this.roles ??= this.store.projectRoles(this.person.id);
    return [...this.roles.values()].includes('member');
  }

  canSeeProject(project: string): boolean {
    return this.role(project) !== undefined;
  }

  canWorkInProject(project: string): boolean {
    const role = this.role(project);
    return role === 'owner' || role === 'member';
  }

  private projectOf(meta: SessionMeta): string | undefined {
    return this.store.projectFor(meta.cwd)?.slug;
  }

  canSeeSession(meta: SessionMeta): boolean {
    if (this.owner) return true;
    const project = this.projectOf(meta);
    // Outside a project there are no roles: it's yours if you started it or were brought into it.
    return project ? this.canSeeProject(project) : meta.startedBy === this.actor || this.inThread(meta.id);
  }

  canWorkInSession(meta: SessionMeta): boolean {
    if (this.owner) return true;
    const project = this.projectOf(meta);
    return project ? this.canWorkInProject(project) : meta.startedBy === this.actor || this.inThread(meta.id);
  }

  private inThread(id: string): boolean {
    return this.store.threadPeople(id).includes(this.person.id);
  }

  /** A connection's owner looks after it: tests it, reconnects it, says what its credential can do. */
  canManageConnection(connection: { owner: string }): boolean {
    return this.owner || connection.owner === this.person.id;
  }

  /** Granting is the install owner's for now (settled brief §7 leaves a per-project admin for later). */
  get canGrant(): boolean {
    return this.owner;
  }

  /** A library agent can be used wherever the person works; a project's agent only in its project. */
  canSeeAgent(agent: { project: string | null }): boolean {
    return agent.project === null ? this.owner || this.store.projectRoles(this.person.id).size > 0 : this.canSeeProject(agent.project);
  }
}

/** Refusals that don't reveal whether something the person can't see exists. */
export const NOT_FOUND = 'No such session.';
export const READ_ONLY = 'You can read this, but not act here: you’re a viewer.';
export const OWNER_ONLY = 'Only the owner of this install can change that.';
