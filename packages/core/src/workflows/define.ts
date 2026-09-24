import { PolyphemusError } from '../types.js';
import type { Worker } from '../isolation/workers.js';

// Workflows as code (docs/design/workflows.md): "orchestration is code, intelligence is in the nodes".
// A workflow is a list of nodes the engine walks. The code decides what runs next, whether a node is
// done, and what happens on failure; a model only ever does the work inside an agent node, and says
// it's finished by submitting an artifact that has to fit the node's shape.

/** A small, checkable description of an artifact: enough to refuse "done" that isn't. */
export type Shape =
  | { type: 'string'; description?: string; min?: number }
  | { type: 'number'; description?: string }
  | { type: 'boolean'; description?: string }
  | { type: 'array'; items: Shape; description?: string; min?: number }
  | { type: 'object'; properties: Record<string, Shape>; required?: string[]; description?: string };

export interface CheckResult {
  command: string;
  exitCode: number | null;
  ok: boolean;
  /** The end of what it printed, for the next attempt and for you. */
  output: string;
  /** The commit it ran on, in a repository. */
  head?: string;
  /** Pictures it kept, as files polyphemus holds: a page it opened, at one size. */
  files?: string[];
}

/** What a check done by code — not a shell command — found: a result each, and any pictures to keep. */
export interface Probe {
  results: Array<CheckResult & { image?: { title: string; png: Buffer } }>;
  /** Why it passed without looking, when it did: "The plan names no pages." */
  note?: string;
}

/** A GitHub identity a workflow acts as, resolved from what's granted to the run's project. */
export interface GitHubActor {
  connection: string;
  /** The app's name, e.g. "polyphemus Builder 3f9a1c". */
  name: string;
  /** How GitHub shows it: slug[bot]. */
  login: string;
  /** An installation token for this action only: workflow code holds it, a model never does. */
  token: string;
  author: { name: string; email: string };
}

export interface GateOption {
  id: string;
  label: string;
  detail?: string;
}

/** What polyphemus lends a workflow's code. */
export interface WorkflowServices {
  github(role: 'planner' | 'builder' | 'reviewer'): Promise<GitHubActor>;
  /** Whether an installed identity for the role is granted to the run's project. */
  hasGitHub(role: 'planner' | 'builder' | 'reviewer'): boolean;
  /** A work item in the run's project: its own thread with this outcome, not started. The same title twice is the same item. */
  workItem(item: { title: string; body: string }): Promise<{ sessionId: string }>;
  /** The worker a run's own commands (checks, a preview, a look at its pages) run in for a folder, where agents are isolated; undefined on this computer. */
  worker(cwd: string): Promise<Worker | undefined>;
}

/** What a node can see when it runs. */
export interface NodeContext {
  runId: string;
  input: Record<string, unknown>;
  /** The latest artifact each agent node submitted, by node id. */
  artifacts: Record<string, unknown>;
  /** The latest results of each check node, by node id. */
  checks: Record<string, CheckResult[]>;
  /** In a loop: which round this is, from 1. */
  round?: number;
  /** The folder the run works in: the thread's, or the workflow's own (a worktree) once it has one. */
  cwd: string;
  /** The folder of the thread the run was started in. */
  home: string;
  project?: string;
  services: WorkflowServices;
}

/** A permit to act, issued by the engine for one node in one generation of a run. Nothing a model writes is one. */
export interface Permit {
  runId: string;
  node: string;
  generation: number;
  /** Doing the same action twice with the same key does it once. */
  key: string;
}

export type WorkflowNode =
  | {
      kind: 'agent';
      id: string;
      title: string;
      /** Which agent does it; unset means the thread's own. */
      agent?: string;
      prompt: (ctx: NodeContext) => string;
      output: Shape;
      /** Only reads: anything that would change things is declined. */
      readOnly?: boolean;
      /** Done by a model from a different vendor than the one that did this node: a judge that isn't the author. */
      independentOf?: string;
    }
  | {
      kind: 'check';
      id: string;
      title: string;
      /** Shell commands, each passing on exit 0. A check has these or a probe, not both. */
      commands?: (ctx: NodeContext) => string[];
      /** Code that checks instead, like opening a site's pages in a browser. */
      probe?: (ctx: NodeContext) => Promise<Probe>;
      timeoutMs?: number;
      /** Why it failed, in words, when the command itself isn't the explanation. */
      says?: (results: CheckResult[]) => string | undefined;
    }
  | {
      kind: 'gate';
      id: string;
      title: string;
      asks: (ctx: NodeContext) => string;
      when?: (ctx: NodeContext) => boolean;
      /** Things to pick from: allowing it keeps the ones picked, saved as this node's artifact (their ids). */
      options?: (ctx: NodeContext) => GateOption[];
    }
  | {
      kind: 'action';
      id: string;
      title: string;
      key: (ctx: NodeContext) => string;
      run: (ctx: NodeContext, permit: Permit) => Promise<unknown>;
      /** What it did, in a line, for the step: "Pushed abc1234 as polyphemus Builder". */
      says?: (result: any) => string;
    }
  | {
      kind: 'loop';
      id: string;
      title: string;
      body: WorkflowNode[];
      /** The check in the body that ends the loop when it passes. */
      until: string;
      /** Hard cap on rounds. */
      max: number | ((ctx: NodeContext) => number);
    };

export interface Workflow {
  id: string;
  name: string;
  /** One line: what it's for. */
  about: string;
  /** What starting it takes. */
  input: Extract<Shape, { type: 'object' }>;
  nodes: WorkflowNode[];
  /** Attempts per node before it fails (default 3). */
  attempts?: number;
  /** Caps for the whole run. */
  budget?: { wallMs?: number; tokens?: number };
  /**
   * What to start when a run finishes — the next in a queue — from what this one was started with. It
   * starts in a thread of its own, only after this run is done; a run that fails or is sent back
   * starts nothing, and offers it instead.
   */
  next?: (input: Record<string, unknown>) => { workflow: string; input: Record<string, unknown> } | undefined;
  /** Runs with the same key, in the same project, can't overlap: one ship per issue. */
  oneAtATime?: (input: Record<string, unknown>) => string;
  /** Where its nodes work once it has somewhere of its own, like a worktree an action made. */
  cwd?: (ctx: NodeContext) => string | undefined;
  /** The outcome it's tracking, in words, from its input. */
  outcome: (input: Record<string, unknown>) => string;
}

/** Checks a workflow's shape when it's loaded, so a broken one never starts. */
export function defineWorkflow(workflow: Workflow): Workflow {
  const fail = (message: string): never => {
    throw new PolyphemusError(`Workflow ${workflow.id}: ${message}`, 'USAGE');
  };
  if (!/^[a-z0-9][a-z0-9-]*$/.test(workflow.id)) fail('its id should be lowercase words and dashes.');
  if (workflow.nodes.length === 0) fail('it has no nodes.');
  const seen = new Set<string>();
  const walk = (nodes: WorkflowNode[], inLoop: boolean) => {
    for (const node of nodes) {
      if (!/^[a-z0-9][a-z0-9-]*$/.test(node.id)) fail(`node id "${node.id}" should be lowercase words and dashes.`);
      if (seen.has(node.id)) fail(`two nodes are called "${node.id}".`);
      seen.add(node.id);
      if (node.kind === 'check' && !node.commands === !node.probe) fail(`check "${node.id}" needs commands or a probe, and not both.`);
      if (node.kind === 'loop') {
        if (inLoop) fail(`loop "${node.id}" is inside another loop; one level is enough.`);
        if (node.body.length === 0) fail(`loop "${node.id}" has nothing in it.`);
        const until = node.body.find((child) => child.id === node.until);
        if (!until || until.kind !== 'check') fail(`loop "${node.id}" ends on "${node.until}", which has to be a check inside it.`);
        if (typeof node.max === 'number' && (!Number.isInteger(node.max) || node.max < 1)) fail(`loop "${node.id}" needs a whole-number cap of at least 1.`);
        walk(node.body, true);
      }
    }
  };
  walk(workflow.nodes, false);
  const agents = new Set<string>();
  const each = (nodes: WorkflowNode[]): WorkflowNode[] => nodes.flatMap((n) => (n.kind === 'loop' ? [n, ...each(n.body)] : [n]));
  for (const node of each(workflow.nodes)) if (node.kind === 'agent') agents.add(node.id);
  for (const node of each(workflow.nodes)) if (node.kind === 'agent' && node.independentOf && !agents.has(node.independentOf)) fail(`"${node.id}" is independent of "${node.independentOf}", which isn't an agent node.`);
  return workflow;
}

/** Whether a value fits a shape. Returns what's wrong, in words, or nothing. */
export function misfit(value: unknown, shape: Shape, path = 'it'): string | undefined {
  switch (shape.type) {
    case 'string':
      if (typeof value !== 'string') return `${path} should be text`;
      if (shape.min !== undefined && value.trim().length < shape.min) return `${path} is empty`;
      return undefined;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? undefined : `${path} should be a number`;
    case 'boolean':
      return typeof value === 'boolean' ? undefined : `${path} should be true or false`;
    case 'array': {
      if (!Array.isArray(value)) return `${path} should be a list`;
      if (shape.min !== undefined && value.length < shape.min) return `${path} needs at least ${shape.min}`;
      for (let i = 0; i < value.length; i++) {
        const wrong = misfit(value[i], shape.items, `${path}[${i}]`);
        if (wrong) return wrong;
      }
      return undefined;
    }
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return `${path} should be an object`;
      const record = value as Record<string, unknown>;
      for (const key of shape.required ?? []) if (record[key] === undefined) return `${path === 'it' ? key : `${path}.${key}`} is missing`;
      for (const [key, child] of Object.entries(shape.properties)) {
        if (record[key] === undefined) continue;
        const wrong = misfit(record[key], child, path === 'it' ? key : `${path}.${key}`);
        if (wrong) return wrong;
      }
      return undefined;
    }
  }
}

/** A shape as JSON Schema, for a model's tool definition. */
export function toJsonSchema(shape: Shape): Record<string, unknown> {
  switch (shape.type) {
    case 'array':
      return { type: 'array', items: toJsonSchema(shape.items), ...(shape.description && { description: shape.description }) };
    case 'object':
      return {
        type: 'object',
        properties: Object.fromEntries(Object.entries(shape.properties).map(([k, v]) => [k, toJsonSchema(v)])),
        required: shape.required ?? [],
        ...(shape.description && { description: shape.description }),
      };
    default:
      return { type: shape.type, ...(shape.description && { description: shape.description }) };
  }
}
