import { PolyphemusError } from '../types.js';
import { runtimeRun, shortHash, type ContainerRuntime } from './runtime.js';

// The image every worker starts from: a slim Debian with a shell, git and the everyday tools agents
// reach for, and Chromium with fonts, for looking at pages in a worker. Built on this computer the first time it's needed, named after its own contents so a
// change to it builds a new one rather than reusing a stale one.

export const WORKER_DOCKERFILE = `FROM debian:bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8
RUN apt-get update \\
 && apt-get install -y --no-install-recommends bash ca-certificates curl git jq ripgrep python3 procps less file unzip xz-utils nodejs npm make chromium fonts-dejavu-core fonts-liberation fonts-noto-color-emoji \\
 && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /polyphemus && chmod 1777 /polyphemus && echo "polyphemus-worker: commands here run isolated" > /etc/polyphemus-worker
CMD ["sleep", "infinity"]
`;

export const WORKER_IMAGE = `polyphemus-worker:${shortHash(WORKER_DOCKERFILE)}`;

const building = new Map<string, Promise<void>>();

/** The worker image exists on this runtime, built now if it didn't. Slow the first time: it downloads. */
export function ensureWorkerImage(runtime: ContainerRuntime): Promise<void> {
  const key = `${runtime.command}:${WORKER_IMAGE}`;
  let build = building.get(key);
  if (!build) {
    build = (async () => {
      const present = await runtimeRun(runtime, ['image', 'inspect', WORKER_IMAGE], { timeoutMs: 30_000 });
      if (present.code === 0) return;
      const built = await runtimeRun(runtime, ['build', '-t', WORKER_IMAGE, '-'], { stdin: WORKER_DOCKERFILE, timeoutMs: 15 * 60_000 });
      if (built.code !== 0) throw new PolyphemusError(`Couldn’t build polyphemus’s worker image with ${runtime.name}: ${built.stderr.trim().split('\n').slice(-3).join(' ')}`, 'FAILED');
      // Earlier versions of the image are a gigabyte each; one still in use by a container stays.
      const listed = await runtimeRun(runtime, ['images', '--format', '{{.Repository}}:{{.Tag}}', 'polyphemus-worker'], { timeoutMs: 30_000 });
      const old = listed.stdout.split('\n').map((line) => line.trim()).filter((name) => name.startsWith('polyphemus-worker:') && name !== WORKER_IMAGE);
      for (const name of old) await runtimeRun(runtime, ['image', 'rm', name], { timeoutMs: 60_000 });
    })();
    building.set(key, build);
    build.catch(() => building.delete(key));
  }
  return build;
}
