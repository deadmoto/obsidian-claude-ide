import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';

const IDE_NAME = 'Obsidian';

function lockDirectory(): string {
  return path.join(os.homedir(), '.claude', 'ide');
}

export interface LockPayload {
  workspaceFolders: string[];
  pid: number;
  ideName: string;
  transport: 'ws';
  authToken: string;
}

export interface LockFileData {
  workspaceFolders: string[];
  pid: number;
  ideName: 'Obsidian';
  transport: 'ws';
  authToken: string;
}

export async function ensureIdeDir(): Promise<string> {
  await ensureDirectoryMode700(getLockDir());
  return getLockDir();
}

export function getLockDir(): string {
  return lockDirectory();
}

function resolveLockPath(port: number): string {
  return path.join(getLockDir(), `${port}.lock`);
}

export function getLockFilePath(port: number): string {
  return resolveLockPath(port);
}

export function getLockPath(port: number): string {
  return resolveLockPath(port);
}

export async function ensureDirectoryMode700(dirPath: string): Promise<void> {
  try {
    await fs.mkdir(dirPath, { mode: 0o700, recursive: true });
  } catch {
    // handled by caller.
  }
  await fs.chmod(dirPath, 0o700);
}

export async function listLockPaths(): Promise<string[]> {
  try {
    const entries = await fs.readdir(getLockDir());
    return entries.filter((entry) => entry.endsWith('.lock')).map((entry) => path.join(getLockDir(), entry));
  } catch (error) {
    const err = error as { code?: string };
    if (err.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

export async function writeLockFile(port: number, data: { workspaceFolders: string[]; authToken: string; pid?: number }): Promise<string> {
  await cleanStaleLocks();

  await ensureIdeDir();
  const payload: LockFileData = {
    workspaceFolders: data.workspaceFolders,
    pid: data.pid ?? process.pid,
    ideName: IDE_NAME,
    transport: 'ws',
    authToken: data.authToken
  };

  const lockPath = resolveLockPath(port);
  const handle = await fs.open(lockPath, 'w', 0o600);
  await handle.writeFile(JSON.stringify(payload, null, 2), 'utf8');
  await handle.close();
  return lockPath;
}

export async function deleteLockFile(port: number): Promise<void> {
  await fs.unlink(resolveLockPath(port)).catch(() => undefined);
}

export async function readLockFile(lockPath: string): Promise<LockFileData | null> {
  try {
    const raw = await fs.readFile(lockPath, 'utf8');
    const parsed = JSON.parse(raw) as LockFileData;
    return parsed;
  } catch {
    return null;
  }
}

export async function findLockForWorkspace(workspaceFolder: string): Promise<LockFileData | null> {
  const locks = await listLockPaths();
  for (const lockPath of locks) {
    const payload = await readLockFile(lockPath);
    if (!payload) {
      continue;
    }
    if (payload.ideName === IDE_NAME && payload.workspaceFolders.includes(workspaceFolder)) {
      return payload;
    }
  }

  return null;
}

export async function cleanStaleLocks(): Promise<number[]> {
  const removedPorts: number[] = [];

  const locks = await listLockPaths();
  await ensureDirectoryMode700(getLockDir());

  await Promise.all(
    locks.map(async (lockPath) => {
      const payload = await readLockFile(lockPath);
      if (!payload || payload.ideName !== IDE_NAME) {
        return;
      }

      const alive = await isPidAlive(payload.pid);
      if (!alive) {
        await fs.unlink(lockPath).catch(() => undefined);
        const port = Number.parseInt(path.basename(lockPath, '.lock'), 10);
        if (Number.isFinite(port) && port > 0) {
          removedPorts.push(port);
        }
      }
    })
  );

  return removedPorts;
}

async function isPidAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
