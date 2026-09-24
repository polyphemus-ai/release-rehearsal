import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { Worker } from '../isolation/workers.js';
import type { ToolSpec } from '../types.js';

export interface ToolContext {
  cwd: string;
  signal?: AbortSignal;
  /** Environment for commands the tool runs (secrets already removed). */
  env?: NodeJS.ProcessEnv;
  /** Isolated: commands and file operations happen in this worker, not on this computer. */
  worker?: Worker;
}

/** Said when a path is outside what an isolated worker was given. */
export const notGranted = (path: string) =>
  `${path} isn’t in what this project’s worker was given (its folder and memory), so it can’t be reached from here. Work inside the project.`;

export interface ToolOutput {
  content: string;
  isError?: boolean;
  /** Pictures to hand the model with the text, as bytes; the loop keeps them like attached images. */
  images?: Array<{ bytes: Uint8Array }>;
}

export interface Tool {
  spec: ToolSpec;
  /** Tools that can change things go through the client's approval callback. */
  mutates: boolean;
  /** For a tool that can change things: whether this particular call only reads (then it runs without asking). */
  isReadOnly?(input: Record<string, unknown>): boolean;
  /** One-line summary of a call, for display and approval prompts. */
  describe(input: Record<string, unknown>): string;
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput>;
}

const MAX_OUTPUT_CHARS = 30_000;

/** Keeps the head and tail of long output, which is where the useful parts usually are. */
export function truncate(text: string, max = MAX_OUTPUT_CHARS): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n\n[... ${text.length - max} characters truncated ...]\n\n${text.slice(-half)}`;
}

export function requireString(input: Record<string, unknown>, key: string, opts: { allowEmpty?: boolean } = {}): string {
  const value = input[key];
  if (typeof value !== 'string' || (!opts.allowEmpty && value === '')) {
    throw new Error(`Missing required string parameter "${key}"`);
  }
  return value;
}

export function optionalInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : undefined;
}

export function resolvePath(cwd: string, path: string): string {
  return resolve(cwd, path.replace(/^~(?=$|\/)/, homedir()));
}
