# ssh-latest-auth-sock

A Linux-only SSH agent forwarder that always routes to whichever `SSH_AUTH_SOCK` was most recently set up on the host.

[![npm](https://img.shields.io/npm/v/ssh-latest-auth-sock.svg)](https://www.npmjs.com/package/ssh-latest-auth-sock)
[![CI](https://github.com/cinderblock/ssh-latest-auth-sock/actions/workflows/ci.yml/badge.svg)](https://github.com/cinderblock/ssh-latest-auth-sock/actions/workflows/ci.yml)

## The problem

You SSH into the same host several times — say a build server you keep open in two terminals. Each session brings its own forwarded agent socket, typically at `/tmp/ssh-XXXXXX/agent.NNN`. The shell that landed last has the freshest `SSH_AUTH_SOCK`, but anything you started in earlier shells still points at *their* (now stale) sockets. The classic frustration: detached `tmux` panes whose `SSH_AUTH_SOCK` died with the original session.

## The fix

`ssh-latest-auth-sock` runs as a long-lived daemon listening on a stable unix-domain path (defaults to `~/.ssh/auth.sock`). Every time something connects, it scans `/proc/<pid>/environ` for processes whose `SSH_AUTH_SOCK` points at a real, currently-listening agent socket — sorts those by process start time, picks the newest one that's responsive, and pipes the connection through.

Export `SSH_AUTH_SOCK=~/.ssh/auth.sock` once in your shell rc. Every later SSH operation gets the latest agent, no re-exporting required.

## Install

```bash
npm install -g ssh-latest-auth-sock
```

## Usage

### As a daemon (recommended)

```bash
ssh-latest-auth-sock daemon
# logs: Listening on /home/you/.ssh/auth.sock
```

Then, once and for all:

```bash
# ~/.bashrc or ~/.zshrc
export SSH_AUTH_SOCK=~/.ssh/auth.sock
```

A systemd user unit is the obvious place for this — example:

```ini
# ~/.config/systemd/user/ssh-latest-auth-sock.service
[Unit]
Description=Forward SSH_AUTH_SOCK to the latest live agent

[Service]
ExecStart=/usr/local/bin/ssh-latest-auth-sock daemon
Restart=on-failure

[Install]
WantedBy=default.target
```

```bash
systemctl --user enable --now ssh-latest-auth-sock
```

### One-shot path lookup

```bash
export SSH_AUTH_SOCK="$(ssh-latest-auth-sock path)"
```

This walks the same heuristic and prints the path to the most-recent live socket, then exits. Useful for non-interactive scripts or for re-exporting on demand. Doesn't react to later sessions — re-run when needed.

### As a library

```ts
import {
  findLatestAgent,
  listCandidatesFromProc,
  probeAgent,
  startDaemon,
} from 'ssh-latest-auth-sock';

const path = await findLatestAgent();
console.log('latest:', path);

// Or run the forwarder programmatically:
const server = await startDaemon({
  listenPath: '/tmp/my-auth.sock',
  onListen: p => console.log('listening on', p),
});
```

## Platform

Linux only. The "latest" heuristic walks `/proc/<pid>/environ`, which doesn't exist on macOS or Windows. The CLI and tests skip on non-Linux platforms.

## License

MIT — see [LICENSE](./LICENSE).
