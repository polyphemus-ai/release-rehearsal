import { describe, expect, it } from 'vitest';
import { deriveRun, deriveStep, precheckVerify } from '../src/runs/status.js';
import type { Evidence, Step } from '../src/runs/store.js';
import { checkPlan } from '../src/runs/tools.js';

// Status comes only from what happened (settled brief §4). These are the rules, on their own.

const step = (over: Partial<Step>): Step => ({ id: 's', runId: 'r', n: 1, title: 'A step', kind: 'work', status: 'running', ...over });
const ev = (over: Partial<Evidence>): Evidence => ({ id: 'e', runId: 'r', stepId: 's', kind: 'call', label: 'HubSpot write_contacts', ok: true, at: 0, ...over });
const done = { kind: 'completed' } as const;

describe('a step’s status', () => {
  it('is done for work only with something polyphemus checked', () => {
    expect(deriveStep(step({}), done, [ev({ receipt: 'HubSpot answered' })])).toEqual({ status: 'done' });
    expect(deriveStep(step({}), done, [ev({ kind: 'file', label: 'report.md' })])).toEqual({ status: 'done' });
    expect(deriveStep(step({}), done, []).status).toBe('unknown');
  });

  it('fails on a call that failed, unless the same call later succeeded', () => {
    expect(deriveStep(step({}), done, [ev({ ok: false, detail: '401 Unauthorized' })])).toEqual({ status: 'failed', reason: 'HubSpot write_contacts: 401 Unauthorized' });
    expect(deriveStep(step({}), done, [ev({ ok: false, detail: 'timeout' }), ev({ ok: true })]).status).toBe('done');
    expect(deriveStep(step({}), done, [ev({ ok: false, detail: '401' }), ev({ label: 'HubSpot read_contacts' })]).status).toBe('failed');
  });

  it('is interrupted when stopped and failed on an error, whatever was gathered', () => {
    expect(deriveStep(step({}), { kind: 'aborted' }, [ev({})]).status).toBe('interrupted');
    expect(deriveStep(step({}), { kind: 'error', message: 'quota' }, [ev({})])).toEqual({ status: 'failed', reason: 'quota' });
  });

  it('needs a verify step to record a check, and to have read something to pass it', () => {
    const verify = step({ kind: 'verify', verifies: 1, n: 2 });
    expect(deriveStep(verify, done, [ev({})]).status).toBe('unknown');
    expect(deriveStep({ ...verify, check: { passed: false, what: '4 missing' } }, done, [ev({})])).toEqual({ status: 'failed', reason: 'The check failed: 4 missing' });
    expect(deriveStep({ ...verify, check: { passed: true, what: 'all there' } }, done, []).status).toBe('unknown');
    expect(deriveStep({ ...verify, check: { passed: true, what: 'all there' } }, done, [ev({})]).status).toBe('done');
    expect(deriveStep(step({ kind: 'think' }), done, []).status).toBe('done');
  });

  it('fails a verify before it runs when what it checks isn’t done', () => {
    const verify = step({ kind: 'verify', verifies: 1, n: 2 });
    expect(precheckVerify(verify, step({ status: 'done' }))).toBeUndefined();
    expect(precheckVerify(verify, step({ status: 'failed', reason: '401' }))).toEqual({ status: 'failed', reason: 'Step 1 isn’t done (failed: 401), so there’s no confirmed result to verify.' });
    expect(precheckVerify(verify, undefined)?.status).toBe('failed');
  });
});

describe('a run’s status', () => {
  it('is the most pressing of its steps, and done only when all are', () => {
    expect(deriveRun([step({ status: 'done' }), step({ n: 2, status: 'waiting', title: 'Send it' })])).toEqual({ status: 'waiting', reason: 'Step 2: Send it' });
    expect(deriveRun([step({ status: 'failed', reason: '401' }), step({ n: 2, status: 'queued' })]).status).toBe('failed');
    expect(deriveRun([step({ status: 'done' }), step({ n: 2, status: 'done' })])).toEqual({ status: 'done' });
    expect(deriveRun([]).status).toBe('unknown');
  });
});

describe('a plan', () => {
  it('points every verify back at an earlier step, and has every gate say what it asks', () => {
    expect(checkPlan([{ title: 'Write', kind: 'work' }, { title: 'Check', kind: 'verify', verifies: 1 }, { title: 'Send', kind: 'gate', asks: 'Email it' }])).toHaveLength(3);
    expect(() => checkPlan([])).toThrow(/at least one/);
    expect(() => checkPlan([{ title: 'Check', kind: 'verify', verifies: 1 }])).toThrow(/verifies an earlier step/);
    expect(() => checkPlan([{ title: 'Send', kind: 'gate' }])).toThrow(/asks/);
    expect(() => checkPlan([{ title: 'Send', kind: 'gate', asks: 'x' }, { title: 'Check', kind: 'verify', verifies: 1 }])).toThrow(/can't verify a gate/);
    expect(() => checkPlan([{ title: 'x', kind: 'deploy' }])).toThrow(/kind/);
  });
});
