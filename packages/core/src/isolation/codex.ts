import { sep } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { spawnSync } from 'node:child_process';
import { runtimeSpawn } from './runtime.js';
import type { Worker } from './workers.js';

// Codex, isolated (docs/design/isolation.md): `codex exec` stays on this computer with its sign-in, and
// runs its commands and file operations through an exec-server (CODEX_EXEC_SERVER_URL, experimental in
// Codex) that runs inside the project's worker. Codex only connects to a loopback WebSocket, and a
// worker has no network, so polyphemus bridges: a WebSocket on 127.0.0.1 with a secret path, each
// connection piped to `codex exec-server --listen stdio` started in the worker. Every request is
// counted, so polyphemus can see that what Codex ran went through the worker.

export interface CodexBridge {
  /** For the CLI's environment. */
  env: Record<string, string>;
  /** How many processes Codex started in the worker. */
  processes(): number;
  /** How many file changes (writes, new folders, removals, copies) Codex made in the worker. */
  fsChanges(): number;
  close(): Promise<void>;
}

/** The Codex binary itself (a static build), to mount read-only into the worker. */
export function codexBinary(command = 'codex'): string | undefined {
  const which = spawnSync('bash', ['-c', `command -v ${JSON.stringify(command)}`], { encoding: 'utf8' }).stdout.trim();
  if (!which) return undefined;
  const entry = realpathSync(which);
  // The npm package's `codex` is a Node launcher; the real binaries sit in its vendor folder. The
  // worker is Linux on this machine's architecture, whatever this computer is: on a Mac, only a Linux
  // build of Codex can run there (independent review, 2026-09-19), and without one it isn't offered.
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  // Only an npm install has vendor binaries, and only under the package. Anything else (a codex on
  // PATH of its own, a stand-in in a temporary folder) is taken as it is: this used to walk everything
  // under the folder above the command — all of /tmp for one in a temporary folder — which took
  // minutes and grew with the day (2026-09-22).
  if (!entry.includes(`${sep}node_modules${sep}`)) return process.platform === 'linux' ? entry : undefined;
  const find = (pattern: string) => spawnSync('bash', ['-c', `find "$(dirname "$(dirname "$1")")" -maxdepth 8 -path "$2" -type f -name codex 2>/dev/null | head -1`, 'find', entry, pattern], { encoding: 'utf8' }).stdout.trim();
  const linux = find(`*vendor*${arch}*linux*`);
  if (linux) return linux;
  if (process.platform !== 'linux') return undefined;
  return find('*vendor*') || entry;
}

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export async function startCodexBridge(worker: Worker, binary: string): Promise<CodexBridge> {
  const token = randomBytes(18).toString('hex');
  let processes = 0;
  let fsChanges = 0;
  const sockets = new Set<Socket>();
  const server: Server = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  server.on('upgrade', (req, socket: Socket) => {
    if (req.url !== `/${token}` || typeof req.headers['sec-websocket-key'] !== 'string') {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}${GUID}`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const child = runtimeSpawn(worker.runtime, ['exec', '-i', '--workdir', worker.spec.workdir, worker.name, binary, 'exec-server', '--listen', 'stdio']);
    const send = (payload: Buffer, opcode = 1) => {
      if (socket.destroyed) return;
      const head = payload.length < 126 ? Buffer.from([0x80 | opcode, payload.length]) : payload.length < 65536 ? Buffer.from([0x80 | opcode, 126, payload.length >> 8, payload.length & 255]) : Buffer.concat([Buffer.from([0x80 | opcode, 127]), bigLength(payload.length)]);
      socket.write(Buffer.concat([head, payload]));
    };
    let out = '';
    child.stdout!.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
      let end: number;
      while ((end = out.indexOf('\n')) >= 0) {
        const line = out.slice(0, end);
        out = out.slice(end + 1);
        if (line.trim()) send(Buffer.from(line, 'utf8'));
      }
    });
    child.on('close', () => {
      send(Buffer.alloc(0), 8);
      socket.end();
    });
    let buffer = Buffer.alloc(0);
    let message: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (buffer.length < 2) return;
        const fin = (buffer[0]! & 0x80) !== 0;
        const opcode = buffer[0]! & 0x0f;
        const masked = (buffer[1]! & 0x80) !== 0;
        let length = buffer[1]! & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (buffer.length < 4) return;
          length = buffer.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (buffer.length < 10) return;
          length = Number(buffer.readBigUInt64BE(2));
          offset = 10;
        }
        const mask = masked ? buffer.subarray(offset, offset + 4) : undefined;
        if (masked) offset += 4;
        if (buffer.length < offset + length) return;
        const payload = Buffer.from(buffer.subarray(offset, offset + length));
        buffer = buffer.subarray(offset + length);
        if (mask) for (let i = 0; i < payload.length; i++) payload[i]! ^= mask[i % 4]!;
        if (opcode === 8) {
          child.kill('SIGTERM');
          socket.end();
          return;
        }
        if (opcode === 9) {
          send(payload, 10);
          continue;
        }
        if (opcode === 10) continue;
        message.push(payload);
        if (!fin) continue;
        const text = Buffer.concat(message).toString('utf8');
        message = [];
        if (/"method"\s*:\s*"process\/start"/.test(text)) processes++;
        if (/"method"\s*:\s*"fs\/(writeFile|createDirectory|remove|copy)"/.test(text)) fsChanges++;
        child.stdin!.write(`${text}\n`);
      }
    });
    const end = () => {
      sockets.delete(socket);
      child.kill('SIGTERM');
    };
    socket.on('close', end);
    socket.on('error', end);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    env: { CODEX_EXEC_SERVER_URL: `ws://127.0.0.1:${port}/${token}` },
    processes: () => processes,
    fsChanges: () => fsChanges,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

function bigLength(length: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(length));
  return b;
}

export const CODEX_ISOLATED_NOTE =
  'You are isolated: your commands and file changes run in a container that has only this project’s folder and its memory — no home folder, no credentials, no other projects.';
