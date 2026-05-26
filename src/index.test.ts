import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createServer, createConnection, type Server } from 'node:net';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  findLatestAgent,
  listCandidatesFromProc,
  probeAgent,
  startDaemon,
} from './index.js';

const isLinux = platform() === 'linux';

/** Set up a fake unix-domain socket that accepts connections (and pipes echo). */
async function makeFakeAgent(socketPath: string): Promise<Server> {
  const server = createServer(socket => {
    socket.on('data', chunk => socket.write(chunk));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return server;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>(resolve => server.close(() => resolve()));
}

test('probeAgent returns true for a live socket, false for a missing one', { skip: !isLinux }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'slas-probe-'));
  const live = join(dir, 'live.sock');
  const missing = join(dir, 'missing.sock');
  const server = await makeFakeAgent(live);
  try {
    assert.equal(await probeAgent(live), true);
    assert.equal(await probeAgent(missing), false);
  } finally {
    await closeServer(server);
    await rm(dir, { recursive: true, force: true });
  }
});

test('probeAgent returns false for a stale socket file with no listener', { skip: !isLinux }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'slas-stale-'));
  const stale = join(dir, 'stale.sock');
  const server = await makeFakeAgent(stale);
  await closeServer(server);
  // The OS removes the socket inode on close; recreate as a regular file to
  // simulate a leaked socket path.
  await writeFile(stale, '');
  try {
    assert.equal(await probeAgent(stale), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('findLatestAgent picks the first live candidate in the list', { skip: !isLinux }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'slas-find-'));
  const dead = join(dir, 'dead.sock');
  const live = join(dir, 'live.sock');
  await writeFile(dead, '');
  const server = await makeFakeAgent(live);
  try {
    const result = await findLatestAgent({
      candidates: [
        { socketPath: dead, pid: 999, pidCreationTimeMs: Date.now() },
        { socketPath: live, pid: 1000, pidCreationTimeMs: Date.now() - 1000 },
      ],
    });
    assert.equal(result, live);
  } finally {
    await closeServer(server);
    await rm(dir, { recursive: true, force: true });
  }
});

test('findLatestAgent returns null when nothing is live', { skip: !isLinux }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'slas-none-'));
  try {
    const result = await findLatestAgent({
      candidates: [
        { socketPath: join(dir, 'a.sock'), pid: 1, pidCreationTimeMs: Date.now() },
        { socketPath: join(dir, 'b.sock'), pid: 2, pidCreationTimeMs: Date.now() },
      ],
    });
    assert.equal(result, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('listCandidatesFromProc parses fake /proc entries newest-first', { skip: !isLinux }, async () => {
  const proc = await mkdtemp(join(tmpdir(), 'slas-proc-'));
  const sockDir = await mkdtemp(join(tmpdir(), 'slas-sock-'));

  // Create two real listening sockets so the stat().isSocket() check passes.
  const sockOld = join(sockDir, 'agent.old');
  const sockNew = join(sockDir, 'agent.new');
  const serverOld = await makeFakeAgent(sockOld);
  const serverNew = await makeFakeAgent(sockNew);

  // /proc/100/environ → SSH_AUTH_SOCK=sockOld
  const pidOldDir = join(proc, '100');
  await mkdir(pidOldDir, { recursive: true });
  await writeFile(
    join(pidOldDir, 'environ'),
    Buffer.from(`PATH=/bin\0SSH_AUTH_SOCK=${sockOld}\0HOME=/tmp\0`),
  );

  // Pause to ensure the second mkdir's ctime is strictly later.
  await new Promise(r => setTimeout(r, 50));

  const pidNewDir = join(proc, '200');
  await mkdir(pidNewDir, { recursive: true });
  await writeFile(
    join(pidNewDir, 'environ'),
    Buffer.from(`SSH_AUTH_SOCK=${sockNew}\0PATH=/bin\0`),
  );

  // Also include a noise entry — a non-numeric dir (should be skipped).
  await mkdir(join(proc, 'self'));
  // And a numeric dir with no SSH_AUTH_SOCK in environ.
  await mkdir(join(proc, '300'));
  await writeFile(join(proc, '300', 'environ'), Buffer.from('PATH=/bin\0'));

  try {
    const candidates = await listCandidatesFromProc({ procDir: proc });
    assert.equal(candidates.length, 2);
    assert.equal(candidates[0]!.socketPath, sockNew);
    assert.equal(candidates[0]!.pid, 200);
    assert.equal(candidates[1]!.socketPath, sockOld);
    assert.equal(candidates[1]!.pid, 100);
    assert.ok(
      candidates[0]!.pidCreationTimeMs >= candidates[1]!.pidCreationTimeMs,
      'newest-first sort',
    );
  } finally {
    await closeServer(serverOld);
    await closeServer(serverNew);
    await rm(proc, { recursive: true, force: true });
    await rm(sockDir, { recursive: true, force: true });
  }
});

test('listCandidatesFromProc dedupes processes pointing at the same socket', { skip: !isLinux }, async () => {
  const proc = await mkdtemp(join(tmpdir(), 'slas-dedupe-'));
  const sockDir = await mkdtemp(join(tmpdir(), 'slas-sock-'));
  const sock = join(sockDir, 'agent.shared');
  const server = await makeFakeAgent(sock);

  for (const pid of [100, 101, 102]) {
    const pidDir = join(proc, String(pid));
    await mkdir(pidDir, { recursive: true });
    await writeFile(
      join(pidDir, 'environ'),
      Buffer.from(`SSH_AUTH_SOCK=${sock}\0`),
    );
  }

  try {
    const candidates = await listCandidatesFromProc({ procDir: proc });
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]!.socketPath, sock);
  } finally {
    await closeServer(server);
    await rm(proc, { recursive: true, force: true });
    await rm(sockDir, { recursive: true, force: true });
  }
});

test('listCandidatesFromProc skips environ pointing at non-socket files', { skip: !isLinux }, async () => {
  const proc = await mkdtemp(join(tmpdir(), 'slas-nonsock-'));
  const sockDir = await mkdtemp(join(tmpdir(), 'slas-sock-'));
  const fakeFile = join(sockDir, 'fake.regular');
  await writeFile(fakeFile, ''); // regular file, not a socket

  const pidDir = join(proc, '100');
  await mkdir(pidDir, { recursive: true });
  await writeFile(
    join(pidDir, 'environ'),
    Buffer.from(`SSH_AUTH_SOCK=${fakeFile}\0`),
  );

  try {
    const candidates = await listCandidatesFromProc({ procDir: proc });
    assert.equal(candidates.length, 0);
  } finally {
    await rm(proc, { recursive: true, force: true });
    await rm(sockDir, { recursive: true, force: true });
  }
});

test('startDaemon forwards bytes from client to the selected agent and back', { skip: !isLinux }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'slas-daemon-'));
  const agentSock = join(dir, 'agent.sock');
  const listenSock = join(dir, 'forwarder.sock');

  // The "agent" simply echoes received bytes back, prefixed with "A:".
  const agent = createServer(client => {
    client.on('data', chunk => {
      client.write(Buffer.concat([Buffer.from('A:'), chunk]));
    });
  });
  await new Promise<void>((resolve, reject) => {
    agent.once('error', reject);
    agent.listen(agentSock, () => {
      agent.off('error', reject);
      resolve();
    });
  });

  const daemon = await startDaemon({
    listenPath: listenSock,
    candidates: [
      { socketPath: agentSock, pid: 1, pidCreationTimeMs: Date.now() },
    ],
  });

  try {
    const client = createConnection(listenSock);
    await new Promise<void>((resolve, reject) => {
      client.once('connect', () => resolve());
      client.once('error', reject);
    });

    const echo = await new Promise<Buffer>((resolve, reject) => {
      client.once('data', chunk => resolve(chunk));
      client.once('error', reject);
      client.write('hello');
    });

    assert.equal(echo.toString('utf8'), 'A:hello');
    client.destroy();
  } finally {
    await new Promise<void>(resolve => daemon.close(() => resolve()));
    await new Promise<void>(resolve => agent.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
