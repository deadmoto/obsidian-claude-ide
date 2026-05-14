import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DiscoveryManager } from '../../src/discovery';

describe('DiscoveryManager', () => {
  let home: string;
  let restoreHome: string | undefined;

  beforeAll(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'claude-ide-home-'));
    restoreHome = process.env.HOME;
    process.env.HOME = home;
  });

  afterAll(async () => {
    process.env.HOME = restoreHome;
    await rm(home, { recursive: true, force: true });
  });

  it('creates lock with secure modes and removes stale Obsidian locks', async () => {
    const discovery = new DiscoveryManager();
    const stalePath = discovery.getLockPath(12345);
    await discovery.start(12345, { workspaceFolders: ['/tmp/vault'], authToken: 'abc' });
    const fresh = await discovery.readLock(stalePath);

    expect(fresh).not.toBeNull();
    expect(fresh?.pid).toBe(process.pid);
    expect(fresh?.ideName).toBe('Obsidian');

    // create stale lock for a dead process and ensure cleanup removes it
    const staleLock = discovery.getLockPath(12346);
    await discovery.start(12346, { workspaceFolders: ['/tmp/old'], authToken: 'dead' });
    const stale = await discovery.readLock(staleLock);
    expect(stale).not.toBeNull();

    if (stale) {
      stale.pid = 999999; // clearly dead in CI/container contexts
      const fs = await import('node:fs/promises');
      await fs.writeFile(staleLock, JSON.stringify(stale));
    }

    await discovery.cleanupStaleLocks();

    const staleAfter = await discovery.readLock(staleLock);
    expect(staleAfter).toBeNull();
  });
});
