import { ago, summarizeToolInput, type Message, type ProjectMeta, type SessionMeta } from '@polyphemus/core';
import { iso } from './output.js';
import { bold, cyan, dim, oneLine } from './render.js';

// `poly sessions show`: a session's conversation, for people and for agents, so nobody has to
// screenshot the app to show what a session said.

/** The status block polyphemus adds to a message. */
const STATUS_LINE = /<polyphemus_status>[\s\S]*?<\/polyphemus_status>\s*/g;
const RESULT_CHARS = 300;

export interface TranscriptView {
  text: string;
  json: {
    session: Record<string, unknown>;
    messages: Array<{ role: Message['role']; from?: string; content: unknown[] }>;
  };
}

/** A session as readable text and as JSON. `last` limits it to the most recent messages. */
export function transcriptView(meta: SessionMeta, messages: readonly Message[], project: ProjectMeta | undefined, last?: number): TranscriptView {
  const shown = last ? messages.slice(-last) : messages;
  // The per-message status line is for the model, and provider-native payloads are for replay: neither is the conversation.
  const clean = shown.map((message) => ({
    role: message.role,
    ...(message.origin && { from: `${message.origin.provider}:${message.origin.model}` }),
    content: message.content.map((block) => {
      if (block.type === 'text') return { ...block, text: block.text.replace(STATUS_LINE, '') };
      if (block.type === 'thinking') return { type: 'thinking', text: (block as { text?: string }).text ?? '' };
      return block;
    }),
  }));

  const lines = [
    `${bold(meta.title || '(untitled)')}  ${dim(meta.id)}`,
    dim(
      [
        `${meta.provider}:${meta.model}`,
        project ? `project ${project.slug}` : undefined,
        meta.cwd,
        `${messages.length} messages${shown.length < messages.length ? `, last ${shown.length} shown` : ''}`,
        `updated ${ago(meta.updatedAt)}`,
      ]
        .filter(Boolean)
        .join(' · '),
    ),
  ];
  let speaker = '';
  const say = (who: string) => {
    if (who === speaker) return;
    speaker = who;
    lines.push('', cyan(`── ${who}`));
  };
  for (const message of clean) {
    for (const block of message.content as Array<{ type: string; [key: string]: unknown }>) {
      if (block.type === 'text' && String(block.text).trim()) {
        say(message.role === 'user' ? 'you' : (message.from?.split(':')[0] ?? 'assistant'));
        lines.push(String(block.text).trim());
      } else if (block.type === 'tool_call') {
        say(message.from?.split(':')[0] ?? 'assistant');
        lines.push(`  ● ${String(block.name)}  ${oneLine(summarizeToolInput(block.input as Record<string, unknown>), 160)}`);
      } else if (block.type === 'image') {
        say('you');
        lines.push(dim(`[image${block.name ? `: ${String(block.name)}` : ''}]`));
      } else if (block.type === 'tool_result') {
        lines.push(dim(`    ↳ ${block.isError ? 'error: ' : ''}${oneLine(String(block.content), RESULT_CHARS)}`));
      }
    }
  }

  return {
    text: lines.join('\n'),
    json: {
      session: {
        id: meta.id,
        title: meta.title,
        provider: meta.provider,
        model: meta.model,
        cwd: meta.cwd,
        project: project?.slug ?? null,
        messageCount: messages.length,
        createdAt: iso(meta.createdAt),
        updatedAt: iso(meta.updatedAt),
      },
      messages: clean,
    },
  };
}
