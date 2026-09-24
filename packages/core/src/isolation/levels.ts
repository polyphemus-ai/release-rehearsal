// Where an agent's commands and file operations run: the owner's choice of risk, for the install and
// narrowed per project (docs/design/isolation.md). A project can be stricter than the install, never looser.

export type IsolationLevel = 'isolated' | 'isolated-open' | 'host';

/** Strictest first. */
export const ISOLATION_LEVELS: readonly IsolationLevel[] = ['isolated', 'isolated-open', 'host'];

export const ISOLATION_WORDS: Record<IsolationLevel, { title: string; says: string }> = {
  isolated: {
    title: 'Isolated',
    says: 'Commands and file changes run in a container with only this project’s folder and its memory. No network except hosts you grant, no home folder, no credentials, nothing that controls polyphemus.',
  },
  'isolated-open': {
    title: 'Isolated, open network',
    says: 'The same container, with network to any public host: for installing packages and fetching from the web. Never this computer or your local network.',
  },
  host: {
    title: 'On this computer',
    says: 'Commands and file changes run as you, on this computer: anything you can reach, they can. Polyphemus’s guards keep credential files out of reach, but they aren’t a boundary.',
  },
};

export const isIsolationLevel = (value: unknown): value is IsolationLevel => typeof value === 'string' && (ISOLATION_LEVELS as readonly string[]).includes(value);

/** The level that applies: the project's when it's set and at least as strict as the install's. */
export function effectiveLevel(install: IsolationLevel, project?: IsolationLevel | null): IsolationLevel {
  if (!project) return install;
  return ISOLATION_LEVELS.indexOf(project) <= ISOLATION_LEVELS.indexOf(install) ? project : install;
}
