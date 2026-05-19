import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import { findFreePort, tryPort } from '../bridge/net';

describe('bridge port helpers', () => {
  it('returns false when port is in use', async () => {
    const server = createServer();
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });

    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const available = await tryPort(port);

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });

    expect(port).toBeGreaterThan(0);
    expect(available).toBe(false);
  });

  it('finds an available high-range port', async () => {
    const port = await findFreePort();

    expect(port).toBeGreaterThanOrEqual(49152);
    expect(port).toBeLessThanOrEqual(65535);
  });
});