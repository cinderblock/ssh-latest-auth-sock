#!/usr/bin/env node

import { findLatestAgent, startDaemon, DEFAULT_LISTEN_PATH } from './index.js';

function printHelp(): void {
  process.stdout.write(`ssh-latest-auth-sock — forward SSH_AUTH_SOCK to the latest live agent

Usage:
  ssh-latest-auth-sock daemon [path]   start the forwarder (default: ${DEFAULT_LISTEN_PATH})
  ssh-latest-auth-sock path            print the current latest live SSH_AUTH_SOCK
  ssh-latest-auth-sock --help          show this message

Examples:
  ssh-latest-auth-sock daemon
  export SSH_AUTH_SOCK=~/.ssh/auth.sock

  export SSH_AUTH_SOCK="$(ssh-latest-auth-sock path)"
`);
}

async function main(argv: string[]): Promise<number> {
  const args = argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === '--help' || cmd === '-h') {
    printHelp();
    return cmd ? 0 : 1;
  }

  if (cmd === 'path') {
    const path = await findLatestAgent();
    if (!path) {
      process.stderr.write('No live SSH_AUTH_SOCK candidates found\n');
      return 1;
    }
    process.stdout.write(path + '\n');
    return 0;
  }

  if (cmd === 'daemon') {
    const listenPath = args[1] ?? DEFAULT_LISTEN_PATH;
    const server = await startDaemon({
      listenPath,
      onListen: p => process.stderr.write(`Listening on ${p}\n`),
      onError: err => process.stderr.write(`error: ${err.message}\n`),
    });
    const shutdown = (signal: NodeJS.Signals) => {
      process.stderr.write(`\nReceived ${signal}, shutting down…\n`);
      server.close(() => process.exit(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    return new Promise<number>(() => {
      // Never resolve — daemon runs until killed.
    });
  }

  process.stderr.write(`Unknown command: ${cmd}\n`);
  printHelp();
  return 1;
}

main(process.argv).then(
  code => process.exit(code),
  err => {
    process.stderr.write(`${err?.stack ?? err}\n`);
    process.exit(1);
  },
);
