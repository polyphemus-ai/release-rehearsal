import type { Block, Message } from './types.js';

export function clip(text: string, max: number): string {
  const flat = text.replace(/\s*\n\s*/g, ' ⏎ ');
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Rewrites tool calls the current tool set doesn't have (e.g. Claude Code's own
 * `Bash`, from a turn an agent CLI ran) and their results as plain text, so any
 * provider accepts the history. Deterministic, so the prompt cache still hits.
 */
export function fitHistoryToTools(messages: readonly Message[], toolNames: ReadonlySet<string>): Message[] {
  const foreignCalls = new Map<string, string>();
  return messages.map((message) => {
    let changed = false;
    const content = message.content.map((block): Block => {
      if (block.type === 'tool_call' && !toolNames.has(block.name)) {
        foreignCalls.set(block.id, block.name);
        changed = true;
        return { type: 'text', text: `[called ${block.name} ${clip(JSON.stringify(block.input), 500)}]` };
      }
      if (block.type === 'tool_result' && foreignCalls.has(block.callId)) {
        changed = true;
        const label = block.isError ? 'error' : 'result';
        return { type: 'text', text: `[${foreignCalls.get(block.callId)} ${label}: ${clip(block.content, 2000)}]` };
      }
      return block;
    });
    if (!changed) return message;
    // The native form no longer matches the content, so it can't be replayed.
    const { native: _native, ...rest } = message;
    return { ...rest, content };
  });
}

/**
 * Puts a conversation back in a shape every provider accepts, when more than one agent has been
 * working in it (docs/design/parallel-agents.md). Their turns interleave in the thread — which is
 * what a person wants to read — but a model needs each tool call answered by its own result, one
 * after the other. Messages keep their order otherwise; a result is moved up to its call, and a call
 * nobody answered (a turn that was stopped) is given one that says so.
 */
export function stitchHistory(messages: readonly Message[]): Message[] {
  const resultFor = new Map<string, { message: Message; at: number }>();
  messages.forEach((message, at) => {
    for (const block of message.content) if (block.type === 'tool_result') resultFor.set(block.callId, { message, at });
  });
  const moved = new Set<number>();
  const out: Message[] = [];
  messages.forEach((message, at) => {
    if (moved.has(at)) return;
    const calls = message.content.filter((b) => b.type === 'tool_call');
    if (!calls.length) {
      // A result whose call is gone would be refused on its own.
      const orphans = message.content.filter((b) => b.type === 'tool_result' && !messages.some((m) => m.content.some((c) => c.type === 'tool_call' && c.id === b.callId)));
      if (orphans.length && orphans.length === message.content.length) return;
      out.push(message);
      return;
    }
    out.push(message);
    // Every call this message made, answered right here, in order; anything else that came with an
    // answer follows after, where it can't break the pair.
    const answers: Block[] = [];
    const after: Message[] = [];
    for (const call of calls) {
      const found = call.type === 'tool_call' ? resultFor.get(call.id) : undefined;
      if (found) {
        moved.add(found.at);
        const mine = (b: Block) => b.type === 'tool_result' && calls.some((c) => c.type === 'tool_call' && c.id === b.callId);
        answers.push(...found.message.content.filter(mine));
        const rest = found.message.content.filter((b) => !mine(b));
        if (rest.length) after.push({ ...found.message, content: rest });
      } else if (call.type === 'tool_call') {
        answers.push({ type: 'tool_result', callId: call.id, content: 'The turn stopped before this finished.', isError: true });
      }
    }
    if (answers.length) out.push({ role: 'user', content: answers });
    out.push(...after);
  });
  return out;
}
