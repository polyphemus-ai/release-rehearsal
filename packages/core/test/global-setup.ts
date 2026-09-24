import { ensureWorkerImage } from '../src/isolation/image.js';
import { detectRuntime } from '../src/isolation/runtime.js';

// The worker image, built once before any test starts, where there's a container runtime. Built
// inside whichever test first needed it, a machine without it cached — every CI runner — spent
// minutes on it against a wait of seconds, and slowed every test beside it: the first time CI ran,
// the isolated ship-issue journey timed out, and the Browser connection's with it (2026-09-23).
export default async function setup(): Promise<void> {
  if (process.env.POLYPHEMUS_NO_CONTAINERS === '1') return;
  const runtime = detectRuntime({ candidates: ['docker', 'podman'] });
  if (runtime) await ensureWorkerImage(runtime);
}
