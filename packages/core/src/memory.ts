import { dirname, join } from 'node:path';
import { PolyphemusError } from './types.js';
import { createInside, listInside, readInside } from './contained.js';

// What an agent remembers beyond one thread, and where each memory may be recalled (docs/design/memory.md).
// A memory can only come back in a room no more open than the one it was learned in:
//
//   private  what you told this agent, in your own threads with it — never where anyone else is
//   craft    what it learned about doing its work, and about nobody: any thread, with anyone
//   project  what the project knows: any thread in that project (projects.ts)
//
// Nothing is written by an agent: it proposes, a person accepts, and accepting is what decides the scope.

export type MemoryScope = 'private' | 'craft' | 'project';

/** One phrase each, for the tool's description. */
export const MEMORY_SCOPE_WORDS: Record<MemoryScope, string> = {
  private: 'only your threads with this person alone',
  craft: 'any thread with you, with anyone',
  project: 'any thread in this project',
};

export const MEMORY_SCOPES: Record<MemoryScope, { title: string; where: string }> = {
  private: { title: 'Only with you', where: 'only in your own threads with this agent — never where anyone else is' },
  craft: { title: 'Anywhere', where: 'in any thread with this agent, with anyone: keep people and private facts out of it' },
  project: { title: 'In this project', where: 'in any thread in this project, with anyone who works there' },
};

const safe = (text: string) => text.replace(/[^\w.-]+/g, '-').replace(/^-|-$/g, '').toLowerCase();

/** Everything one agent remembers, whoever it's with. */
export const agentMemoryDir = (home: string, agent: string) => join(home, 'memory', 'agents', safe(agent));
/** What this agent learned about its work: recalled in any thread with it. */
export const craftMemoryDir = (home: string, agent: string) => join(agentMemoryDir(home, agent), 'craft');
/** What one person told this agent: recalled only in threads between the two of them. */
export const privateMemoryDir = (home: string, agent: string, person: string) => join(agentMemoryDir(home, agent), 'people', safe(person));

export interface MemoryNote {
  file: string;
  name: string;
  description: string;
}

/** The notes in a folder, newest names last, with the line that says when each is useful. */
export function memoryNotes(folder: string, root = folder): MemoryNote[] {
  return listInside(root, folder)
    .filter((file) => file.endsWith('.md'))
    .sort()
    .flatMap((file) => {
      const text = readInside(root, join(folder, file));
      return text === undefined ? [] : [{ file: join(folder, file), name: file.replace(/\.md$/, ''), description: describe(text) }];
    });
}

const describe = (text: string) => /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1]?.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? text.trim().split('\n')[0]?.slice(0, 120) ?? '';

/** A note as it's kept: what it's for on top, so recall can be about when it's useful. */
export function writeMemoryNote(folder: string, name: string, description: string, text: string, root = dirname(folder)): string {
  const slug = safe(name).slice(0, 60) || 'note';
  // A project's memory is mounted where its agents work: its folders may be links they made.
  const content = Buffer.from(`---\ndescription: ${description.replace(/\n/g, ' ').trim()}\n---\n\n${text.trim()}\n`);
  for (let n = 1; ; n++) {
    const file = join(folder, n === 1 ? `${slug}.md` : `${slug}-${n}.md`);
    try {
      createInside(root, file, content);
      return file;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
}

/**
 * What the agent is told it remembers, for this thread: its craft notes always, and what this person
 * told it only when the two of them are alone. One line each — it opens the ones that look relevant.
 */
export function memoryBriefing(home: string, opts: { agent: string; agentTitle: string; person?: string; personName?: string; alone: boolean }): string {
  const craft = memoryNotes(craftMemoryDir(home, opts.agent), join(home, 'memory'));
  const own = opts.alone && opts.person ? memoryNotes(privateMemoryDir(home, opts.agent, opts.person), join(home, 'memory')) : [];
  if (!craft.length && !own.length) return '';
  const lines = [`<memory agent="${opts.agentTitle}">`];
  if (craft.length) {
    lines.push('What you\'ve learned about your work (open one when it looks relevant):', ...craft.map((n) => `- ${n.file}: ${n.description}`));
  }
  if (own.length) {
    lines.push(
      `${craft.length ? '\n' : ''}What ${opts.personName ?? 'this person'} told you, in your threads with them alone. Never repeat it where anyone else is:`,
      ...own.map((n) => `- ${n.file}: ${n.description}`),
    );
  }
  lines.push('</memory>');
  return lines.join('\n');
}

/** Where a memory learned here may be kept: never wider than the room it was learned in. */
export function scopesHere(opts: { alone: boolean; project?: string }): MemoryScope[] {
  return [...(opts.alone ? (['private'] as const) : []), ...(opts.project ? (['project'] as const) : []), 'craft'];
}

export function checkScope(scope: string, here: MemoryScope[]): MemoryScope {
  if (!here.includes(scope as MemoryScope)) {
    throw new PolyphemusError(
      scope === 'private'
        ? 'Private memory is for your threads with this person alone; someone else is here.'
        : scope === 'project'
          ? 'This thread isn’t in a project.'
          : `Keep it as one of: ${here.join(', ')}.`,
      'USAGE',
    );
  }
  return scope as MemoryScope;
}
