import type { ToolOutput } from './tools/tool.js';
import type { CapacityReading, Message, StopReason, ToolCall, Usage } from './types.js';

/** Everything a client sees during a turn, whichever kind of provider runs it. */
export type PolyphemusEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_call_start'; id: string; name: string }
  | { type: 'tool_start'; call: ToolCall; summary: string }
  | { type: 'tool_end'; call: ToolCall; result: ToolOutput }
  /** A message was appended to the conversation. Clients persist these. */
  | { type: 'message'; message: Message; /** Who wrote it: person:<id>, agent:<id>, routine:<id>. */ actor?: string }
  /** An agent CLI reported its own session id, used to resume it next turn. */
  | { type: 'agent_session'; provider: string; id: string }
  /** A provider reported how much of a usage window is left. */
  | { type: 'capacity'; provider: string; readings: CapacityReading[] }
  /** Something worth showing that isn't part of the reply (a retry, denied tools). */
  | { type: 'notice'; text: string }
  | {
      type: 'turn_done';
      stopReason: StopReason;
      usage: Usage;
      detail?: string;
      costUsd?: number;
      /** `plan`: covered by a subscription, so costUsd is only what the API would have charged. */
      billing?: 'plan' | 'metered';
    };
