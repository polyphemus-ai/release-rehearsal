import { describe, expect, it } from 'vitest';
import { pickerView, type PickItem } from '../src/picker.js';

const items: PickItem<string>[] = ['claude', 'codex', 'grok', 'claude-api', 'gpt-api', 'grok-api'].map((label) => ({ label, value: label }));

describe('pickerView', () => {
  it('filters by typed text and keeps the cursor on a match', () => {
    const view = pickerView(items, 'api', 5, 10);
    expect(view.rows.map((r) => r.item.label)).toEqual(['claude-api', 'gpt-api', 'grok-api']);
    expect(view.cursor).toBe(2);
    expect(view.rows[2]?.selected).toBe(true);
  });

  it('scrolls so the selection stays on screen', () => {
    const view = pickerView(items, '', 5, 3);
    expect(view.rows.map((r) => r.item.label)).toEqual(['claude-api', 'gpt-api', 'grok-api']);
    expect(view.rows.at(-1)?.selected).toBe(true);
  });

  it('matches on the detail text too', () => {
    const detailed: PickItem<string>[] = [
      { label: 'claude', detail: 'claude-code:default ✓ your subscription', value: 'claude' },
      { label: 'grok-api', detail: 'xai:grok-4.6 ✗ needs an API key', value: 'grok-api' },
    ];
    expect(pickerView(detailed, 'needs', 0, 5).rows.map((r) => r.item.value)).toEqual(['grok-api']);
  });

  it('handles no matches', () => {
    expect(pickerView(items, 'zzz', 0, 5)).toMatchObject({ matches: 0, rows: [] });
  });
});
