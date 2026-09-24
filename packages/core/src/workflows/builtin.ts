import { defineWorkflow, type Workflow } from './define.js';
import { intakeWorkflow } from './intake.js';
import { shipIssueWorkflow, specWorkflow } from './ship.js';

// Workflows polyphemus ships (docs/design/workflows.md, "Built-in workflows"). You configure these; you
// don't write them.

/**
 * `loop`: keep going until a check passes (the Ralph pattern, done properly). A fresh session every
 * round, state kept in files and git, an objective exit check, and a hard cap — and the same failure
 * twice in a row stops to ask you, rather than burning rounds on no progress.
 */
export const loopWorkflow = defineWorkflow({
  id: 'loop',
  name: 'Loop until it passes',
  about: 'Work toward a goal a round at a time until a command passes, with a cap on rounds.',
  input: {
    type: 'object',
    properties: {
      goal: { type: 'string', description: 'What it’s working toward, in a sentence.', min: 1 },
      until: { type: 'string', description: 'A command that exits 0 when the goal is met, like pnpm test.', min: 1 },
      max: { type: 'number', description: 'The most rounds it may take (default 5).' },
    },
    required: ['goal', 'until'],
  },
  outcome: (input) => String(input.goal),
  budget: { wallMs: 4 * 60 * 60_000 },
  nodes: [
    {
      kind: 'loop',
      id: 'rounds',
      title: 'Round',
      until: 'until',
      max: (ctx) => Math.min(Math.max(Number(ctx.input.max) || 5, 1), 20),
      body: [
        {
          kind: 'agent',
          id: 'work',
          title: 'Work on it',
          prompt: (ctx) => {
            const last = ctx.checks.until?.find((r) => !r.ok);
            return [
              `Goal: ${String(ctx.input.goal)}`,
              `This is round ${ctx.round}. When you've done what you can this round, polyphemus runs \`${String(ctx.input.until)}\`; the goal is met only when that exits 0. Whatever you say about it doesn't count — the command does.`,
              last
                ? last.output.trim()
                  ? `Last round it failed (exit ${last.exitCode ?? 'none'}):\n\`\`\`\n${last.output.slice(-2500)}\n\`\`\``
                  : `Last round it failed (exit ${last.exitCode ?? 'none'}), and printed nothing.`
                : 'This is the first round.',
              'Keep your progress in the files (commit if this is a repository), since the next round starts a fresh session that only sees the files and this note. Then call submit with what you changed and what you’d try next.',
            ].join('\n\n');
          },
          output: {
            type: 'object',
            properties: {
              changed: { type: 'string', description: 'What you changed this round.', min: 1 },
              next: { type: 'string', description: 'What you’d try next if the check still fails.' },
            },
            required: ['changed'],
          },
        },
        { kind: 'check', id: 'until', title: 'Check', commands: (ctx) => [String(ctx.input.until)] },
      ],
    },
  ],
});

export const BUILTIN_WORKFLOWS: readonly Workflow[] = [loopWorkflow, intakeWorkflow, shipIssueWorkflow, specWorkflow];

/** Workflows added at runtime: custom ones, and tests'. */
const registered = new Map<string, Workflow>();
export function registerWorkflow(workflow: Workflow): void {
  registered.set(workflow.id, defineWorkflow(workflow));
}

export const allWorkflows = (): Workflow[] => [...BUILTIN_WORKFLOWS, ...registered.values()];
export const findWorkflow = (id: string) => registered.get(id) ?? BUILTIN_WORKFLOWS.find((w) => w.id === id);
