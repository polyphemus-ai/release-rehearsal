import { clip } from '../history.js';
import type { Message } from '../types.js';

/** Keeps the handoff to an agent CLI bounded; the most recent context matters most. */
const MAX_TRANSCRIPT_CHARS = 60_000;

/** Renders messages as a plain-text transcript an agent CLI can read. */
export function renderTranscript(messages: readonly Message[]): string {
  const entries: string[] = [];
  for (const message of messages) {
    const parts = message.content.flatMap((block) => {
      switch (block.type) {
        case 'text':
          return [block.text];
        case 'tool_call':
          return [`[called ${block.name} ${clip(JSON.stringify(block.input), 300)}]`];
        case 'tool_result':
          return [`[${block.isError ? 'error' : 'result'}: ${clip(block.content, 500)}]`];
        case 'image':
          // The agent can open the saved file if it needs to see it.
          return [`[attached image${block.name ? ` ${block.name}` : ''}, saved at ${block.path}]`];
        case 'thinking':
          return [];
      }
    });
    if (parts.length === 0) continue;
    const speaker =
      message.role === 'assistant'
        ? `Assistant${message.origin ? ` (${message.origin.provider}:${message.origin.model})` : ''}`
        : message.content.every((b) => b.type === 'tool_result')
          ? 'Tool results'
          : 'User';
    entries.push(`${speaker}: ${parts.join('\n')}`);
  }
  const transcript = entries.join('\n\n');
  return transcript.length > MAX_TRANSCRIPT_CHARS ? `…${transcript.slice(-MAX_TRANSCRIPT_CHARS)}` : transcript;
}

/**
 * Prepends what an agent CLI missed: the whole conversation if it's joining for
 * the first time, or the turns other models took since it last spoke.
 */
export function withMissedContext(prompt: string, missed: readonly Message[], resumed: boolean): string {
  const transcript = renderTranscript(missed);
  if (!transcript) return prompt;
  const intro = resumed
    ? 'While you were away, the conversation continued with other models:'
    : 'You are joining a conversation that started with other models. Here it is so far:';
  return `<conversation_context>\n${intro}\n\n${transcript}\n</conversation_context>\n\n${prompt}`;
}
