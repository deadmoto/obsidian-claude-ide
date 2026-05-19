import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  cleanStaleLocks,
  deleteLockFile,
  getLockPath,
  listLockPaths,
  readLockFile,
  writeLockFile
} from '../bridge/discovery';

describe('discovery lock-file helpers', () => {
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
    const lockPath = getLockPath(12345);
    await writeLockFile(12345, { workspaceFolders: ['/tmp/vault'], authToken: 'abc' });
    const fresh = await readLockFile(lockPath);

    expect(fresh).not.toBeNull();
    expect(fresh?.pid).toBe(process.pid);
    expect(fresh?.ideName).toBe('Obsidian');

    // create stale lock for a dead process and ensure cleanup removes it.
    const stalePath = getLockPath(12346);
    await writeLockFile(12346, { workspaceFolders: ['/tmp/old'], authToken: 'dead', pid: 999999 });
    await cleanStaleLocks();

    const staleAfter = await readLockFile(stalePath);
    expect(staleAfter).toBeNull();

    const lockPaths = await listLockPaths();
    expect(lockPaths).toContain(lockPath);
    await deleteLockFile(12345);
  });
});
