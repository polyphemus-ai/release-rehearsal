import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaudeCodeAgent } from '../src/agents/claude-cli.js';

// Claude Code can start subagents on a model of its own choosing: polyphemus ran Opus, and a subagent
// could run on Fable. Your list of models is the limit, so they're pinned to the turn's model.

async function fakeClaude(dir: string): Promise<string> {
  const file = join(dir, 'claude');
  await writeFile(
    file,
    `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(__filename + '.env', JSON.stringify({ model: process.env.CLAUDE_CODE_SUBAGENT_MODEL ?? null, force: process.env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE ?? null }));
process.stdin.on('data', () => {}).on('end', () => {
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done', stop_reason: 'end_turn', num_turns: 1, session_id: 's1', usage: { input_tokens: 1, output_tokens: 1 } }) + '\\n');
});
`,
  );
  await chmod(file, 0o755);
  return file;
}

async function run(model: string) {
  const dir = await mkdtemp(join(tmpdir(), 'polyphemus-claude-subagents-'));
  const command = await fakeClaude(dir);
  const agent = new ClaudeCodeAgent('claude-code', { command });
  for await (const _event of agent.run({ prompt: 'hi', model, cwd: dir, autoApprove: false, signal: new AbortController().signal })) void _event;
  return JSON.parse(await readFile(`${command}.env`, 'utf8')) as { model: string | null; force: string | null };
}

describe('Claude Code subagents', () => {
  it('run on the model the turn is on, whatever model they ask for', async () => {
    expect(await run('claude-opus-5')).toEqual({ model: 'claude-opus-5', force: '1' });
  });

  it('stay on the model Claude Code picked for the turn, when it picks', async () => {
    expect(await run('default')).toEqual({ model: null, force: '1' });
  });
});
