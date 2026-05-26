/**
 * ssh-latest-auth-sock — Linux-only SSH agent forwarder.
 *
 * Runs as a long-lived daemon listening on a stable unix-domain socket path
 * (typically `~/.ssh/auth.sock`). When a client (an SSH process or anything
 * speaking the ssh-agent protocol) connects, the daemon finds the most-recent
 * live `SSH_AUTH_SOCK` on the host — by scanning `/proc/<pid>/environ` for
 * processes whose env points at a real, currently-listening agent — and
 * transparently bidirectionally pipes the connection through to that agent.
 *
 * Typical use: a user with multiple concurrent SSH sessions on the same box.
 * Each new session brings its own forwarded agent socket under `/tmp/ssh-*`.
 * Exporting `SSH_AUTH_SOCK=~/.ssh/auth.sock` once lets every shell pick up
 * whichever forwarded agent is currently active, without re-exporting.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { unlink } from 'node:fs/promises';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { mkdir } from 'node:fs/promises';

/** A candidate agent socket discovered via `/proc` scanning. */
export interface AgentCandidate {
  /** Path of the unix-domain socket the agent is listening on. */
  socketPath: string;
  /** PID of the process whose env pointed us here. */
  pid: number;
  /** `/proc/<pid>` directory ctime in ms (used for "most recent" sorting). */
  pidCreationTimeMs: number;
}

/** Reasonable default install path for the forwarder socket. */
export const DEFAULT_LISTEN_PATH = join(homedir(), '.ssh', 'auth.sock');

/** Default per-probe connect timeout. */
const DEFAULT_PROBE_TIMEOUT_MS = 200;

/** Where /proc lives. Overridable for tests. */
const DEFAULT_PROC_DIR = '/proc';

export interface FindOptions {
  /** Override the proc root (tests). */
  procDir?: string;
  /** Optional explicit candidate list — short-circuits proc scanning. */
  candidates?: AgentCandidate[];
  /** Per-probe connect timeout. */
  probeTimeoutMs?: number;
}

/**
 * Pull the value of an env variable out of a NUL-separated `/proc/.../environ`
 * blob. Returns null if not present.
 */
function envFromBlob(blob: Buffer, name: string): string | null {
  const prefix = name + '=';
  let start = 0;
  for (let i = 0; i < blob.length; i++) {
    if (blob[i] === 0) {
      const slice = blob.subarray(start, i).toString('utf8');
      if (slice.startsWith(prefix)) return slice.slice(prefix.length);
      start = i + 1;
    }
  }
  // No trailing NUL: check final segment.
  if (start < blob.length) {
    const slice = blob.subarray(start).toString('utf8');
    if (slice.startsWith(prefix)) return slice.slice(prefix.length);
  }
  return null;
}

/**
 * Scan `/proc` for processes whose env contains an `SSH_AUTH_SOCK` pointing
 * at an existing socket file. Returns candidates sorted newest-first.
 *
 * Silently skips processes whose `/proc/<pid>/environ` we can't read (EACCES
 * for other users' processes, ESRCH for vanished processes, etc.).
 */
export async function listCandidatesFromProc(
  options: { procDir?: string } = {},
): Promise<AgentCandidate[]> {
  const procDir = options.procDir ?? DEFAULT_PROC_DIR;
  let entries: string[];
  try {
    entries = await readdir(procDir);
  } catch {
    return [];
  }

  const seenPaths = new Set<string>();
  const results: AgentCandidate[] = [];

  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    const pidDir = join(procDir, entry);

    let blob: Buffer;
    let pidStat: Awaited<ReturnType<typeof stat>>;
    try {
      [blob, pidStat] = await Promise.all([
        readFile(join(pidDir, 'environ')),
        stat(pidDir),
      ]);
    } catch {
      continue;
    }

    const sock = envFromBlob(blob, 'SSH_AUTH_SOCK');
    if (!sock) continue;
    // Don't loop through our own forwarder.
    if (seenPaths.has(sock)) continue;

    let sockStat: Awaited<ReturnType<typeof stat>>;
    try {
      sockStat = await stat(sock);
    } catch {
      continue;
    }
    if (!sockStat.isSocket()) continue;

    seenPaths.add(sock);
    results.push({
      socketPath: sock,
      pid,
      pidCreationTimeMs: pidStat.ctimeMs,
    });
  }

  results.sort((a, b) => b.pidCreationTimeMs - a.pidCreationTimeMs);
  return results;
}

/**
 * Try to connect to a unix-domain socket. Resolves with `true` if `connect`
 * succeeds before the timeout; `false` otherwise. Does NOT do any protocol
 * handshake — for ssh-agent sockets, a successful connect is sufficient
 * evidence the agent is alive (the kernel rejects connects to orphaned
 * socket files with ECONNREFUSED).
 */
export function probeAgent(
  socketPath: string,
  timeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false;
    const settle = (alive: boolean): void => {
      if (settled) return;
      settled = true;
      try {
        sock.destroy();
      } catch {
        // ignore
      }
      resolve(alive);
    };
    const sock = createConnection(socketPath);
    const timer = setTimeout(() => settle(false), timeoutMs);
    sock.once('connect', () => {
      clearTimeout(timer);
      settle(true);
    });
    sock.once('error', () => {
      clearTimeout(timer);
      settle(false);
    });
  });
}

/**
 * Find the most-recent live SSH agent socket. Returns its path, or null if
 * nothing was found.
 */
export async function findLatestAgent(
  options: FindOptions = {},
): Promise<string | null> {
  const candidates =
    options.candidates ??
    (await listCandidatesFromProc({ procDir: options.procDir }));

  for (const candidate of candidates) {
    if (await probeAgent(candidate.socketPath, options.probeTimeoutMs)) {
      return candidate.socketPath;
    }
  }
  return null;
}

export interface DaemonOptions extends FindOptions {
  /** Path the forwarder will listen on. Defaults to `~/.ssh/auth.sock`. */
  listenPath?: string;
  /** If the path exists when the daemon starts, remove it first. Default true. */
  unlinkExisting?: boolean;
  /** Called once the daemon is listening, with the resolved path. */
  onListen?: (listenPath: string) => void;
  /** Hook for logging / metrics. */
  onError?: (err: Error) => void;
}

/**
 * Start the forwarding daemon and return the underlying `Server`. Each
 * incoming connection triggers a fresh `findLatestAgent()` call.
 */
export async function startDaemon(options: DaemonOptions = {}): Promise<Server> {
  const listenPath = options.listenPath ?? DEFAULT_LISTEN_PATH;
  const onError = options.onError ?? ((err: Error) => console.error(err));

  await mkdir(dirname(listenPath), { recursive: true });

  if (options.unlinkExisting !== false) {
    try {
      await unlink(listenPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw err;
    }
  }

  const server = createServer(async (client: Socket) => {
    let agentPath: string | null;
    try {
      agentPath = await findLatestAgent({
        procDir: options.procDir,
        candidates: options.candidates,
        probeTimeoutMs: options.probeTimeoutMs,
      });
    } catch (err) {
      onError(err as Error);
      client.destroy();
      return;
    }
    if (!agentPath) {
      onError(new Error('No live SSH_AUTH_SOCK candidates found'));
      client.destroy();
      return;
    }

    const upstream = createConnection(agentPath);
    upstream.once('error', err => {
      onError(err);
      client.destroy();
    });
    client.once('error', err => {
      onError(err);
      upstream.destroy();
    });
    upstream.pipe(client);
    client.pipe(upstream);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(listenPath, () => {
      server.off('error', reject);
      options.onListen?.(listenPath);
      resolve();
    });
  });

  return server;
}
