import { describe, it } from 'vitest';
import { detectRuntime } from '../src/isolation/runtime.js';

// Worker isolation is the boundary agents run behind, so a run without Docker or Podman mustn't look
// like a run that tested it. The suite turns polyphemus's own detection off (vitest.config.ts) and these
// tests find the runtime themselves; where there is none, they say so and fail, unless whoever is
// running them says they know (POLYPHEMUS_NO_CONTAINERS=1 — a machine that can't, like CI on macOS).

export const containerRuntime = detectRuntime({ candidates: ['docker', 'podman'] });

const excused = () => process.env.POLYPHEMUS_NO_CONTAINERS === '1';

/**
 * A suite that needs a real container. With none, it's one failing test naming what went untested —
 * never a silent skip, which reads as green.
 */
export function describeInContainers(title: string, body: () => void): void {
  if (containerRuntime) {
    describe(title, body);
    return;
  }
  if (excused()) {
    describe.skip(`${title} (no container runtime; POLYPHEMUS_NO_CONTAINERS=1)`, body);
    return;
  }
  describe(title, () => {
    it('needs Docker or Podman, and there is none', () => {
      throw new Error(
        `"${title}" tests how agents are held inside a worker, and this machine has no container runtime, so none of it ran.\n` +
          'Install Docker or Podman, or run with POLYPHEMUS_NO_CONTAINERS=1 to say you know worker isolation went untested.',
      );
    });
  });
}

/**
 * One test that needs a real container. `itInContainers.when(false)` is an ordinary test: a case that
 * only sometimes needs one (the same journey run isolated and not).
 */
type TestBody = () => void | Promise<void>;
const run = (title: string, body: TestBody, timeout?: number) => (timeout === undefined ? it(title, body) : it(title, { timeout }, body));
const skip = (title: string, body: TestBody, timeout?: number) => (timeout === undefined ? it.skip(title, body) : it.skip(title, { timeout }, body));

function inContainers(title: string, body: TestBody, timeout?: number): void {
  if (containerRuntime) {
    run(title, body, timeout);
    return;
  }
  if (excused()) {
    skip(`${title} (no container runtime; POLYPHEMUS_NO_CONTAINERS=1)`, body, timeout);
    return;
  }
  it(`${title} — needs Docker or Podman, and there is none`, () => {
    throw new Error(`This tests how agents are held inside a worker, and none of it ran: install Docker or Podman, or run with POLYPHEMUS_NO_CONTAINERS=1.`);
  });
}

export const itInContainers = Object.assign(inContainers, {
  when: (needed: boolean) => (needed ? inContainers : (title: string, body: TestBody, timeout?: number) => void it(title, body, timeout)),
});
