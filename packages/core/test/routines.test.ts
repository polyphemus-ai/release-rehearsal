import { describe, expect, it } from 'vitest';
import { dueFiring, nextFire, nextRoutineFire, parseRoutine, upcomingFires, type ProjectMeta, type Routine } from '../src/index.js';

const project: ProjectMeta = { slug: 'side-quest', name: 'Side Quest', path: '/p/side-quest', status: 'active', description: '', createdAt: 0 };
const file = '/p/side-quest/.polyphemus/routines/morning-brief.md';
const parse = (text: string, where: Parameters<typeof parseRoutine>[2] = { project }) => parseRoutine(text, file, where);

describe('routine files', () => {
  it('reads settings and the prompt, with quiet defaults', () => {
    const routine = parse(`---
triggers:
  - { cron: "30 8 * * 1-5", tz: America/Chicago }
  - { every: 30m }
mode: yolo
---
Write the morning brief.
`);
    expect(routine).toMatchObject({
      id: 'side-quest/morning-brief',
      name: 'morning-brief',
      project: 'side-quest',
      cwd: '/p/side-quest',
      prompt: 'Write the morning brief.',
      mode: 'yolo',
      overlap: 'skip',
      catchup: 'latest',
      notify: ['failure'],
      enabled: true,
      triggers: [
        { kind: 'cron', expr: '30 8 * * 1-5', tz: 'America/Chicago' },
        { kind: 'every', ms: 30 * 60_000, text: '30m' },
      ],
    });
  });

  it('says exactly what to fix', () => {
    expect(() => parse('Write the brief.')).toThrow('start with a --- block');
    expect(() => parse('---\ntriggers: [{ every: 30m }]\ncolour: red\n---\nx')).toThrow('unknown setting "colour"');
    expect(() => parse('---\ntriggers: [{ cron: "61 * * * *" }]\n---\nx')).toThrow('trigger 1: cron "61 * * * *"');
    expect(() => parse('---\ntriggers: [{ every: 10s }]\n---\nx')).toThrow('every must be at least 1m');
    expect(() => parse('---\ntriggers: []\n---\nx')).toThrow('add at least one trigger');
    expect(() => parse('---\ntriggers: [{ every: 5m }]\n---\n')).toThrow('write what the routine should do');
    expect(() => parse('---\ntriggers: [{ every: 5m }]\nmode: wild\n---\nx')).toThrow('mode must be ask or yolo or read-only');
    expect(parse('---\ntriggers: [{ every: 5m }]\nmode: read-only\n---\nx').mode).toBe('read-only');
    // Outside a project, it has to say where it runs.
    expect(() => parse('---\ntriggers: [{ every: 5m }]\n---\nx', {})).toThrow('say where it runs');
    expect(parse('---\ntriggers: [{ every: 5m }]\nproject: side-quest\n---\nx', { findProject: () => project })).toMatchObject({ id: '~/morning-brief', cwd: '/p/side-quest', project: 'side-quest' });
  });
});

describe('schedules', () => {
  const friday3pm = Date.parse('2026-09-11T20:00:00Z'); // 3 PM in Chicago

  it('computes the next times, in the routine’s time zone', () => {
    expect(new Date(nextFire({ kind: 'cron', expr: '30 8 * * 1-5', tz: 'America/Chicago' }, friday3pm)!).toISOString()).toBe('2026-09-14T13:30:00.000Z');
    expect(nextFire({ kind: 'every', ms: 30 * 60_000, text: '30m' }, friday3pm)).toBe(Date.parse('2026-09-11T20:30:00Z'));
    expect(nextFire({ kind: 'once', at: friday3pm + 1000 }, friday3pm)).toBe(friday3pm + 1000);
    expect(nextFire({ kind: 'once', at: friday3pm - 1000 }, friday3pm)).toBeUndefined();
  });

  const every30 = { triggers: [{ kind: 'every', ms: 30 * 60_000, text: '30m' }], catchup: 'latest' } as Routine;

  it('runs a time once it’s due, and catches up once after downtime', () => {
    const slot = Date.parse('2026-09-11T20:30:00Z');
    expect(dueFiring(every30, friday3pm, slot - 60_000)).toEqual({ missed: 0 });
    expect(dueFiring(every30, friday3pm, slot + 10_000)).toMatchObject({ run: { slot }, missed: 0 });
    // Off for three hours: run the latest time once, and count the rest as missed.
    const threeHours = dueFiring(every30, friday3pm, friday3pm + 3 * 3_600_000 + 5 * 60_000);
    expect(threeHours.run?.slot).toBe(friday3pm + 3 * 3_600_000);
    expect(threeHours.missed).toBe(5);
    // catchup: skip runs nothing that's more than a couple of minutes old.
    expect(dueFiring({ ...every30, catchup: 'skip' }, friday3pm, friday3pm + 3 * 3_600_000 + 5 * 60_000)).toEqual({ missed: 6 });
    expect(upcomingFires(every30, friday3pm, 3)).toEqual([slot, slot + 1_800_000, slot + 3_600_000]);
    expect(nextRoutineFire(every30, friday3pm)).toBe(slot);
  });
});
