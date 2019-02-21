import { createConnection, createServer, Server, Socket } from 'net';

const socketPath = '~/.ssh/auth.sock';

export async function getLatestAgentSocket() {
  return new Promise<Socket>((resolve, reject) => {
    const agentSocketPath = '/tmp/ssh-...';
    const c = createConnection(agentSocketPath, () => resolve(c));
  });
}

async function main(path: string) {
  const server = createServer(async connection => {
    const agent = await getLatestAgentSocket();
    agent.pipe(connection);
    connection.pipe(agent);
  });

  server.listen(socketPath);
}

if (require.main === module) main(socketPath);

export default main;
