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

  it('writes locks with secure modes', async () => {
    const lockPath = getLockPath(12345);
    await writeLockFile(12345, { workspaceFolders: ['/tmp/vault'], authToken: 'abc' });
    const fresh = await readLockFile(lockPath);

    expect(fresh).not.toBeNull();
    expect(fresh?.pid).toBe(process.pid);
    expect(fresh?.ideName).toBe('Obsidian');
    await deleteLockFile(12345);
  });

  it('removes locks for dead PIDs', async () => {
    const stalePath = getLockPath(12346);
    await writeLockFile(12346, { workspaceFolders: ['/tmp/old'], authToken: 'dead', pid: 999999 });

    const removed = await cleanStaleLocks();

    expect(await readLockFile(stalePath)).toBeNull();
    expect(removed).toContain(12346);
  });

  it('removes own-PID locks (prior in-process plugin instance left them behind)', async () => {
    // Simulate a stale lock written by a previous plugin instance in this same
    // process — same PID, but it's by definition gone before cleanStaleLocks
    // runs again at next onload.
    const stalePath = getLockPath(12347);
    await writeLockFile(12347, { workspaceFolders: ['/tmp/prev'], authToken: 'prev' });

    const removed = await cleanStaleLocks();

    expect(await readLockFile(stalePath)).toBeNull();
    expect(removed).toContain(12347);
  });
});
