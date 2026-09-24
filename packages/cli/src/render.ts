import { styleText } from 'node:util';
import { formatWhen, type CapacityReading, type PolyphemusEvent, type ToolOutput } from '@polyphemus/core';

type Style = Parameters<typeof styleText>[0];
const style = (format: Style) => (text: string) => styleText(format, text);

export const dim = style('dim');
export const bold = style('bold');
export const red = style('red');
export const green = style('green');
export const yellow = style('yellow');
export const cyan = style('cyan');

const RESULT_PREVIEW_LINES = 3;

/** Turns polyphemus events into terminal output. Tracks the cursor so blocks start on fresh lines. */
export class Renderer {
  private mode: 'idle' | 'text' | 'thinking' = 'idle';
  private atLineStart = true;
  /** Latest usage-window readings per provider this turn, shown with the usage line. */
  private capacity = new Map<string, CapacityReading[]>();

  constructor(private out: NodeJS.WritableStream = process.stdout) {}

  write(text: string): void {
    if (!text) return;
    this.out.write(text);
    this.atLineStart = text.endsWith('\n');
  }

  endLine(): void {
    if (!this.atLineStart) this.write('\n');
  }

  render(event: PolyphemusEvent): void {
    switch (event.type) {
      case 'thinking_delta':
        if (this.mode !== 'thinking') {
          this.endLine();
          this.write(dim('∴ '));
          this.mode = 'thinking';
        }
        this.write(dim(event.text));
        break;
      case 'text_delta':
        if (this.mode !== 'text') {
          this.endLine();
          if (this.mode === 'thinking') this.write('\n');
          this.mode = 'text';
        }
        this.write(event.text);
        break;
      case 'tool_start':
        this.endLine();
        this.mode = 'idle';
        this.write(`${cyan('●')} ${bold(event.call.name)} ${dim(oneLine(event.summary, 120))}\n`);
        break;
      case 'tool_end':
        this.endLine();
        this.mode = 'idle';
        this.write(formatResult(event.result));
        break;
      case 'turn_done': {
        this.endLine();
        this.mode = 'idle';
        const note = stopNote(event.stopReason, event.detail);
        if (note) this.write(`${yellow(note)}\n`);
        const u = event.usage;
        const cache = u.cacheReadTokens ? ` · cache hit ${k(u.cacheReadTokens)}` : '';
        const amount = event.costUsd ? `$${event.costUsd.toFixed(event.costUsd < 0.1 ? 3 : 2)}` : '';
        // On a subscription the CLI still reports what the API would have charged; that isn't a bill.
        const cost = amount ? (event.billing === 'plan' ? ` · ≈${amount} on your plan` : ` · ${amount}`) : '';
        const windows = [...this.capacity.values()].flat().map(formatReading);
        this.capacity.clear();
        const tokensIn = u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens;
        // An interrupted turn can end before any usage is reported; don't print zeros.
        const usage = tokensIn + u.outputTokens > 0 ? [`in ${k(tokensIn)} · out ${k(u.outputTokens)}${cache}${cost}`] : [];
        const parts = [...usage.map((text) => dim(text)), ...windows];
        if (parts.length > 0) this.write(`${dim('↳ ')}${parts.join(dim(' · '))}\n`);
        break;
      }
      case 'notice':
        this.endLine();
        this.mode = 'idle';
        this.write(yellow(`! ${event.text}\n`));
        break;
      case 'capacity':
        this.capacity.set(event.provider, event.readings);
        break;
      case 'tool_call_start':
      case 'agent_session':
      case 'message':
        break;
    }
  }
}

function formatResult(result: ToolOutput): string {
  const lines = result.content.trimEnd().split('\n');
  const shown = lines.slice(0, RESULT_PREVIEW_LINES).map((line, i) => `${i === 0 ? '  ⎿ ' : '    '}${oneLine(line, 120)}`);
  if (lines.length > RESULT_PREVIEW_LINES) shown.push(`    … +${lines.length - RESULT_PREVIEW_LINES} lines`);
  const text = `${shown.join('\n')}\n`;
  return result.isError ? red(text) : dim(text);
}

function stopNote(reason: string, detail?: string): string | undefined {
  switch (reason) {
    case 'end_turn':
    case 'tool_use':
      return undefined;
    case 'aborted':
      return '(interrupted)';
    case 'max_tokens':
      return '(stopped: output limit reached)';
    case 'refusal':
      return `(the model declined${detail ? `: ${detail}` : ''})`;
    default:
      return `(stopped${detail ? `: ${detail}` : ''})`;
  }
}

/** "5h 22%", turning yellow at 75% and red at 90%, with the reset time once it matters. */
function formatReading(reading: CapacityReading): string {
  if (reading.usedPct === undefined) return dim(reading.window);
  const pct = Math.round(reading.usedPct);
  const resets = pct >= 75 && reading.resetsAt ? ` (resets ${formatWhen(reading.resetsAt)})` : '';
  const text = `${reading.window} ${pct}%${resets}`;
  return pct >= 90 ? red(text) : pct >= 75 ? yellow(text) : dim(text);
}


export function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s*\n\s*/g, ' ⏎ ');
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function k(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

