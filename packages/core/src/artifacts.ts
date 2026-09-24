import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { readBytesInside } from './contained.js';
import { basename, extname, join } from 'node:path';
import { blockedMessage, credentialPathFor } from './tools/guard.js';
import { PolyphemusError } from './types.js';

// Artifacts: what an agent made and wants you to see — a chart, a page, a table — shown in the
// thread where it was made rather than described by its path (roadmap: show and connect, 1). Polyphemus
// keeps its own copy, so the thread still shows it after the file changes or goes.

export type ArtifactKind = 'image' | 'svg' | 'html' | 'csv' | 'markdown' | 'text';

export interface Artifact {
  id: string;
  sessionId: string;
  /** Where it goes in the conversation: after this many messages. */
  seq: number;
  title: string;
  kind: ArtifactKind;
  mediaType: string;
  /** The file's own name, for downloading. */
  name: string;
  bytes: number;
  createdAt: number;
  /** Who showed it: agent:<id>, or nobody for a thread without one. */
  by?: string;
  /** The run step it was shown in, if any. */
  stepId?: string;
}

const KINDS: Record<string, { kind: ArtifactKind; mediaType: string }> = {
  '.png': { kind: 'image', mediaType: 'image/png' },
  '.jpg': { kind: 'image', mediaType: 'image/jpeg' },
  '.jpeg': { kind: 'image', mediaType: 'image/jpeg' },
  '.gif': { kind: 'image', mediaType: 'image/gif' },
  '.webp': { kind: 'image', mediaType: 'image/webp' },
  '.svg': { kind: 'svg', mediaType: 'image/svg+xml' },
  '.html': { kind: 'html', mediaType: 'text/html; charset=utf-8' },
  '.htm': { kind: 'html', mediaType: 'text/html; charset=utf-8' },
  '.csv': { kind: 'csv', mediaType: 'text/csv; charset=utf-8' },
  '.md': { kind: 'markdown', mediaType: 'text/markdown; charset=utf-8' },
  '.txt': { kind: 'text', mediaType: 'text/plain; charset=utf-8' },
};

export const ARTIFACT_EXTENSIONS = Object.keys(KINDS);
export const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;
export const ARTIFACT_ID = /^[0-9a-f]{16}$/;

export const artifactsDir = (home: string, sessionId: string) => join(home, 'artifacts', sessionId);
export const artifactFile = (home: string, artifact: Pick<Artifact, 'sessionId' | 'id' | 'name'>) => join(artifactsDir(home, artifact.sessionId), `${artifact.id}${extname(artifact.name).toLowerCase()}`);

/**
 * Copies a file an agent made into the thread's artifacts. Refuses what can't be shown, what's too
 * big, and anything in a credential store — showing a file is reading it.
 */
export function keepArtifact(home: string, source: string, init: { sessionId: string; seq: number; title?: string; by?: string; stepId?: string; within?: string }): Artifact {
  // A credential store first, whatever the file's called.
  const blocked = credentialPathFor(source);
  if (blocked) throw new PolyphemusError(blockedMessage(blocked), 'USAGE');
  const ext = extname(source).toLowerCase();
  const type = KINDS[ext];
  if (!type) throw new PolyphemusError(`Polyphemus can show ${ARTIFACT_EXTENSIONS.join(', ')} files; ${basename(source)} isn’t one.`, 'USAGE');
  // A file in a worker's folder is read from that folder's mount, through no link: an agent could
  // point one at another project's files (third review, 2026-09-19).
  const content = init.within ? readBytesInside(init.within, source, MAX_ARTIFACT_BYTES) : undefined;
  if (init.within && !content) throw new PolyphemusError(`There’s no file at ${source} (a link doesn’t count), or it’s over ${MAX_ARTIFACT_BYTES / 1024 / 1024} MB.`, 'NOT_FOUND');
  let bytes: number;
  try {
    const stat = content ? { isFile: () => true, size: content.length } : statSync(realpathSync(source));
    if (!stat.isFile()) throw new Error('not a file');
    bytes = stat.size;
  } catch {
    throw new PolyphemusError(`There’s no file at ${source}.`, 'NOT_FOUND');
  }
  if (bytes > MAX_ARTIFACT_BYTES) throw new PolyphemusError(`${basename(source)} is ${Math.round(bytes / 1024 / 1024)} MB; polyphemus shows files up to ${MAX_ARTIFACT_BYTES / 1024 / 1024} MB.`, 'USAGE');
  const artifact: Artifact = {
    id: randomUUID().replaceAll('-', '').slice(0, 16),
    sessionId: init.sessionId,
    seq: init.seq,
    title: (init.title?.trim() || basename(source)).slice(0, 120),
    kind: type.kind,
    mediaType: type.mediaType,
    name: basename(source),
    bytes,
    createdAt: Date.now(),
    ...(init.by && { by: init.by }),
    ...(init.stepId && { stepId: init.stepId }),
  };
  mkdirSync(artifactsDir(home, init.sessionId), { recursive: true });
  if (content) writeFileSync(artifactFile(home, artifact), content);
  else copyFileSync(realpathSync(source), artifactFile(home, artifact));
  return artifact;
}
