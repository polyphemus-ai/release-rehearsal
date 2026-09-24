import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigHistory } from './config-edit.js';
import type { Polyphemus } from './polyphemus.js';
import { createAgent, findAgent, libraryAgentsDir, updateAgent, type Agent } from './roster.js';
import { PolyphemusError } from './types.js';

// The default agent (2026-09-13): the one you talk to when you haven't picked another, so a thread
// is never with no one. Named and given a personality when polyphemus is set up; a real agent in your
// library, edited in Team like any other. It follows each thread's model rather than keeping its
// own, and it gets what the project grants — nothing of its own.

export const PERSONALITIES = {
  plain: {
    label: 'Plain and direct',
    lines: ['Plain and direct. The answer first, in short sentences, without filler or flattery.', 'When something is a bad idea, you say so and why, once.'],
  },
  warm: {
    label: 'Warm and encouraging',
    lines: ['Warm and encouraging, without gushing. You notice what’s going well and say it briefly.', 'You explain the why when it helps someone learn, and skip it when they just need the answer.'],
  },
  thorough: {
    label: 'Curious and thorough',
    lines: ['Curious and thorough. You check your work, ask the question that matters before starting, and follow a loose thread when it could change the answer.', 'You keep the write-up short even when the work wasn’t.'],
  },
} as const;
export type Personality = keyof typeof PERSONALITIES;

const slugFor = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

function persona(title: string, personality: Personality | 'own', words?: string): string {
  const voice = personality === 'own' ? [String(words ?? '').trim()] : [...PERSONALITIES[personality].lines];
  return [
    `# ${title}`,
    '',
    `You're ${title}: the agent people talk to in polyphemus when they haven't brought in someone more specific.`,
    '',
    ...voice.filter(Boolean).map((line) => `- ${line}`),
    '- You say what you did, what you didn’t, and what you couldn’t check.',
    '- When a job needs a specialist, you say which agent would fit, or that one is worth making.',
    '- Spending money, changing things outside this computer, and anything that can’t be undone stay with the person.',
  ].join('\n');
}

const INSTRUCTIONS = (title: string) =>
  [`# What ${title} does here`, '', 'Whatever the thread asks: answer questions, do the work in the project folder, use what this project has been granted, and track something as work when it takes several steps. Keep to what was asked.'].join('\n');

/** The default agent, if one is set and still exists. */
export function defaultAgent(polyphemus: Polyphemus, projectRoot?: string, projectSlug?: string): Agent | undefined {
  const name = polyphemus.config.defaultAgent;
  return name ? findAgent(polyphemus.home, projectRoot, name, projectSlug) : undefined;
}

/**
 * Makes the default agent, or re-voices the one that already is. A name that belongs to another agent
 * is refused rather than taken over.
 */
export function setUpDefaultAgent(polyphemus: Polyphemus, opts: { title: string; personality: Personality | 'own'; words?: string; by: string }): Agent {
  const title = opts.title.trim().slice(0, 40);
  const name = slugFor(title);
  if (!name) throw new PolyphemusError('Give it a name with some letters in it.', 'USAGE');
  if (opts.personality === 'own' && !String(opts.words ?? '').trim()) throw new PolyphemusError('Say in a sentence how it should come across.', 'USAGE');
  if (opts.personality !== 'own' && !(opts.personality in PERSONALITIES)) throw new PolyphemusError('Pick one of the personalities, or describe your own.', 'USAGE');
  const dir = libraryAgentsDir(polyphemus.home);
  const exists = existsSync(join(dir, name, 'agent.toml'));
  if (exists && polyphemus.config.defaultAgent !== name) throw new PolyphemusError(`There’s already an agent called ${name}. Pick another name, or make that one the default from its page.`, 'CONFLICT');
  // No model line: it follows each thread's model, so picking a model for a thread still means that model.
  if (!exists) createAgent(dir, name, { title, description: 'The agent you talk to when you haven’t picked another.', mark: { shape: 'circle', color: 'teal' } });
  const agent = findAgent(polyphemus.home, undefined, name)!;
  updateAgent(agent, { title, persona: persona(title, opts.personality, opts.words), instructions: INSTRUCTIONS(title) });
  if (polyphemus.config.defaultAgent !== name) {
    const history = new ConfigHistory(polyphemus.home, polyphemus.store, opts.by);
    history.apply(history.plan('default_agent', name).after, `set default_agent = "${name}"`);
    polyphemus.reloadConfig();
  }
  return findAgent(polyphemus.home, undefined, name)!;
}
