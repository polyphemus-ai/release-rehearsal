import { PolyphemusError, type ErrorCode } from '@polyphemus/core';

// One output contract for agents and scripts (docs/design/cli-for-agents.md §3 and §5): every
// command that supports it prints { ok, schemaVersion, data, warnings, error? } on stdout.

export const SCHEMA_VERSION = 1;

const EXIT_CODES: Record<ErrorCode, number> = { FAILED: 1, USAGE: 2, NOT_FOUND: 3, CONFLICT: 6 };

/**
 * JSON when asked for (--json, POLYPHEMUS_OUTPUT=json) or when something other than a person is
 * reading (stdout isn't a terminal). POLYPHEMUS_OUTPUT=text forces text.
 */
export function wantsJson(flag: boolean | undefined, env: NodeJS.ProcessEnv = process.env, isTTY = process.stdout.isTTY): boolean {
  if (flag) return true;
  const output = env.POLYPHEMUS_OUTPUT;
  if (output === 'json') return true;
  if (output === 'text') return false;
  return !isTTY;
}

export function printJson(data: unknown, warnings: string[] = []): void {
  process.stdout.write(`${JSON.stringify({ ok: true, schemaVersion: SCHEMA_VERSION, data, warnings })}\n`);
}

export function errorEnvelope(err: unknown): { ok: false; schemaVersion: number; error: { code: ErrorCode; message: string; fix?: string } } {
  const code = err instanceof PolyphemusError ? err.code : 'FAILED';
  const message = err instanceof Error ? err.message : String(err);
  const fix = err instanceof PolyphemusError ? err.fix : undefined;
  return { ok: false, schemaVersion: SCHEMA_VERSION, error: { code, message, ...(fix && { fix }) } };
}

export function exitCodeFor(err: unknown): number {
  return err instanceof PolyphemusError ? EXIT_CODES[err.code] : 1;
}

/** Times in JSON are ISO 8601, so any caller can read them. */
export const iso = (ms: number | undefined): string | null => (ms === undefined || ms === null ? null : new Date(ms).toISOString());
