import { createServer, type AddressInfo, type Server } from 'node:net';

const MIN_PORT = 49152;
const MAX_PORT = 65535;

export async function tryPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    const onError = () => {
      cleanup(server, false);
    };

    const onListening = () => {
      cleanup(server, true);
    };

    const cleanup = (srv: Server, available: boolean) => {
      srv.removeListener('error', onError);
      srv.removeListener('listening', onListening);
      if (available) {
        srv.close(() => resolve(true));
        return;
      }
      resolve(false);
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

export async function findFreePort(): Promise<number> {
  const start = MIN_PORT + Math.floor(Math.random() * (MAX_PORT - MIN_PORT + 1));

  for (let i = 0; i <= MAX_PORT - MIN_PORT; i++) {
    const candidate = MIN_PORT + ((start - MIN_PORT + i) % (MAX_PORT - MIN_PORT + 1));
    const available = await tryPort(candidate);
    if (available) {
      return candidate;
    }
  }

  throw new Error('No free TCP port available in high port range.');
}
