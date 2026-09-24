import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Polyphemus } from './polyphemus.js';
import { resolveModel, type ResolvedModel } from './config.js';
import type { Agent } from './roster.js';
import { replaceInside } from './contained.js';

// Making an agent is a name, a face, and a sentence (docs/design/agents.md). The sentence is the
// interesting part: "handles our BD pipeline and keeps the CRM honest" becomes persona.md and
// instructions.md, so nobody has to write a persona from a blank page before they can start.
//
// Two rules hold this together, and both are decisions rather than convenience:
//  - It never gates creation. The agent exists first, with the sentence as its description, and
//    this fills in behind you. If it can't run at all, the agent still works.
//  - It runs on the cheap route, not the agent's own. The agent's model is for the agent's work.

/**
 * What writes personas: a model named `cheap` if there is one, else the agent's own, else the
 * default. Named `cheap` rather than inferred, so it's the user's call what this costs.
 */
export function draftingModel(polyphemus: Polyphemus, agentModel?: string): ResolvedModel | undefined {
  for (const ref of ['cheap', agentModel, polyphemus.config.defaultModel]) {
    if (!ref) continue;
    try {
      return resolveModel(polyphemus.config, ref);
    } catch {
      // Not set up; try the next one.
    }
  }
  return undefined;
}

const PROMPT = (name: string, title: string, description: string) => `Someone is adding an agent to polyphemus — a teammate they'll talk with, the way you'd talk with a colleague.

They named it "${title}"${title === name ? '' : ` (${name})`} and said what it's for, in their words:

  ${description}

Write two short documents about it, from that sentence.

The persona is who it is and how it works: its voice, what it insists on, what it refuses, and where it stops. Write it in the second person ("You ..."). Open with one short line, then three to five bullets. It is character, not a task list.

The instructions are what it actually does here: the work it takes on, how it goes about it, and where its work ends and a person's begins. A short paragraph, or a few bullets.

Rules:
- Take the sentence at its word. Don't invent tools, systems, schedules or people it didn't mention.
- Say where it stops. An agent that knows what isn't its job is worth more than one that doesn't.
- No preamble, no headings, no explaining what you wrote. Plain markdown.
- If the sentence is too thin to say much, write less rather than padding it.

Reply with exactly this and nothing else:

<persona>
...
</persona>
<instructions>
...
</instructions>`;

export interface Draft {
  persona: string;
  instructions: string;
}

/**
 * Writes an agent's persona and instructions from its description. Returns what it wrote, or
 * undefined when there's nothing to run it on or the model didn't answer usefully. Never throws:
 * a failed draft leaves an agent that still works, because its description is already in the
 * prompt.
 */
export async function draftPersona(polyphemus: Polyphemus, agent: Agent, signal?: AbortSignal): Promise<Draft | undefined> {
  const model = draftingModel(polyphemus, agent.model);
  if (!model) return undefined;
  try {
    const reply = await completion(polyphemus, model, PROMPT(agent.name, agent.title, agent.description), signal);
    const draft = parseDraft(reply);
    if (!draft) return undefined;
    // A project's agent: written from the project's folder, replacing rather than following whatever
    // stands there by the time the draft comes back.
    const put = (file: string, text: string) => {
      const from = agent.writeRoot ?? agent.root ?? polyphemus.home;
      replaceInside(from, join(agent.dir, file), Buffer.from(text));
    };
    put('persona.md', `# ${agent.title}\n\n${draft.persona}\n`);
    put('instructions.md', `# What ${agent.title} does here\n\n${draft.instructions}\n`);
    return draft;
  } catch {
    return undefined;
  }
}

/** Both sections, or nothing: half a draft is worse than the blank file it replaced. */
export function parseDraft(reply: string): Draft | undefined {
  const persona = /<persona>([\s\S]*?)<\/persona>/i.exec(reply)?.[1]?.trim();
  const instructions = /<instructions>([\s\S]*?)<\/instructions>/i.exec(reply)?.[1]?.trim();
  return persona && instructions ? { persona, instructions } : undefined;
}

/** One question, one answer, no tools and no stored session — this is not a thread you can find later. */
async function completion(polyphemus: Polyphemus, model: ResolvedModel, prompt: string, signal?: AbortSignal): Promise<string> {
  const provider = polyphemus.registry.get(model.provider);
  let text = '';
  if (provider.kind === 'model') {
    for await (const event of provider.stream({
      model: model.model,
      system: 'You write short, concrete setup documents for software agents. You follow the reply format exactly.',
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      tools: [],
      ...(model.effort ? { effort: model.effort } : {}),
      ...(signal ? { signal } : {}),
    })) {
      if (event.type === 'text_delta') text += event.text;
    }
    return text;
  }
  // A vendor CLI: same question, but it runs its own loop, so it's pinned read-only and given a
  // folder it has no reason to touch.
  for await (const event of provider.run({
    prompt,
    model: model.model,
    cwd: polyphemus.home,
    autoApprove: false,
    readOnly: true,
    ...(signal ? { signal } : {}),
  })) {
    if (event.type === 'text_delta') text += event.text;
  }
  return text;
}
