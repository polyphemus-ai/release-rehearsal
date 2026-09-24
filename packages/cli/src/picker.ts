import { emitKeypressEvents } from 'node:readline';
import { bold, cyan, dim } from './render.js';

export interface PickItem<T> {
  label: string;
  detail?: string;
  /** Shown dimmed when false (still selectable). */
  ready?: boolean;
  value: T;
}

export interface PickerView<T> {
  rows: Array<{ item: PickItem<T>; selected: boolean }>;
  matches: number;
  cursor: number;
}

/** Which items match the filter, and which slice of them fits on screen with the selection visible. */
export function pickerView<T>(items: readonly PickItem<T>[], query: string, cursor: number, height: number): PickerView<T> {
  const q = query.trim().toLowerCase();
  const matches = q ? items.filter((item) => `${item.label} ${item.detail ?? ''}`.toLowerCase().includes(q)) : [...items];
  const at = Math.min(Math.max(cursor, 0), Math.max(matches.length - 1, 0));
  const size = Math.max(1, height);
  const start = Math.min(Math.max(at - Math.floor(size / 2), 0), Math.max(matches.length - size, 0));
  return {
    rows: matches.slice(start, start + size).map((item, i) => ({ item, selected: start + i === at })),
    matches: matches.length,
    cursor: at,
  };
}

interface Key {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  sequence?: string;
}
type KeypressListener = (chunk: string | undefined, key: Key | undefined) => void;

/**
 * Reads a line without echoing it (for API keys). Resolves to undefined on Esc
 * or Ctrl+C. Like `pick`, it sets readline's keypress listeners aside while it runs.
 */
export function readHidden(prompt: string): Promise<string | undefined> {
  const { stdin, stdout } = process;
  if (!stdin.isTTY) return Promise.resolve(undefined);

  emitKeypressEvents(stdin);
  const wasRaw = stdin.isRaw;
  const saved = stdin.listeners('keypress') as KeypressListener[];
  stdin.removeAllListeners('keypress');
  stdin.setRawMode(true);
  stdin.resume();
  stdout.write(prompt);

  let value = '';
  return new Promise((resolve) => {
    const finish = (result: string | undefined) => {
      stdin.removeListener('keypress', onKey);
      stdout.write('\n');
      for (const listener of saved) stdin.on('keypress', listener);
      if (!wasRaw) stdin.setRawMode(false);
      if (saved.length === 0) stdin.pause();
      resolve(result);
    };
    const onKey: KeypressListener = (chunk, key) => {
      if (key?.name === 'return' || key?.name === 'enter') return finish(value.trim());
      if (key?.name === 'escape' || (key?.ctrl && key.name === 'c')) return finish(undefined);
      if (key?.name === 'backspace') {
        value = value.slice(0, -1);
        return;
      }
      if (chunk && !key?.ctrl && !key?.meta) value += [...chunk].filter((ch) => ch >= ' ').join('');
    };
    stdin.on('keypress', onKey);
  });
}

/**
 * An arrow-key picker with type-to-filter. Resolves to the picked value, or
 * undefined on Esc / Ctrl+C. Works with or without a readline interface
 * running: readline's keypress listeners are set aside while the picker is open.
 */
export function pick<T>(title: string, items: readonly PickItem<T>[], initial = 0): Promise<T | undefined> {
  const { stdin, stdout } = process;
  if (!stdin.isTTY || items.length === 0) return Promise.resolve(undefined);

  emitKeypressEvents(stdin);
  const wasRaw = stdin.isRaw;
  const saved = stdin.listeners('keypress') as KeypressListener[];
  stdin.removeAllListeners('keypress');
  stdin.setRawMode(true);
  stdin.resume();

  let query = '';
  let cursor = initial;
  let drawn = 0;
  // Some terminals report a size of 0; treat that as unknown.
  const height = () => Math.max(3, Math.min(items.length, (stdout.rows || 24) - 4));
  const fit = (text: string) => {
    const width = Math.max(20, (stdout.columns || 80) - 1);
    return text.length > width ? `${text.slice(0, width - 1)}…` : text;
  };

  const draw = () => {
    const view = pickerView(items, query, cursor, height());
    cursor = view.cursor;
    const lines = [
      `${bold(title)} ${dim('· type to filter · ↑↓ move · Enter pick · Esc cancel')}`,
      query ? dim(fit(`  filter: ${query}  (${view.matches} match${view.matches === 1 ? '' : 'es'})`)) : '',
      ...view.rows.map(({ item, selected }) => {
        const text = fit(`${selected ? '›' : ' '} ${item.label}${item.detail ? `  ${item.detail}` : ''}`);
        return selected ? cyan(text) : item.ready === false ? dim(text) : text;
      }),
    ];
    if (view.matches === 0) lines.push(dim('  (no matches)'));
    stdout.write(`${drawn ? `\x1b[${drawn}A` : ''}\x1b[J${lines.join('\n')}\n`);
    drawn = lines.length;
  };

  return new Promise((resolve) => {
    const finish = (value: T | undefined) => {
      stdin.removeListener('keypress', onKey);
      stdout.write(`\x1b[${drawn}A\x1b[J\x1b[?25h`);
      for (const listener of saved) stdin.on('keypress', listener);
      if (!wasRaw) stdin.setRawMode(false);
      if (saved.length === 0) stdin.pause();
      resolve(value);
    };
    const onKey: KeypressListener = (_chunk, key) => {
      if (!key) return;
      if (key.name === 'return' || key.name === 'enter') {
        return finish(pickerView(items, query, cursor, height()).rows.find((row) => row.selected)?.item.value);
      }
      if (key.name === 'escape' || (key.ctrl && key.name === 'c')) return finish(undefined);
      if (key.name === 'up' || (key.ctrl && key.name === 'p')) cursor = Math.max(0, cursor - 1);
      else if (key.name === 'down' || (key.ctrl && key.name === 'n')) cursor += 1;
      else if (key.name === 'backspace') {
        query = query.slice(0, -1);
        cursor = 0;
      } else if (key.sequence && key.sequence.length === 1 && key.sequence >= ' ' && !key.ctrl) {
        query += key.sequence;
        cursor = 0;
      } else return;
      draw();
    };
    stdout.write('\x1b[?25l');
    stdin.on('keypress', onKey);
    draw();
  });
}
