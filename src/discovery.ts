import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';

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

export class DiscoveryManager {
  constructor(private readonly log: (message: string) => void = () => undefined) {}

  private get baseDir(): string {
    return lockDirectory();
  }

  getLockDir(): string {
    return this.baseDir;
  }

  async start(port: number, payload: { workspaceFolders: string[]; authToken: string }): Promise<string> {
    await this.cleanupStaleLocks();

    const filePath = this.getLockPath(port);
    await fs.mkdir(this.baseDir, { mode: 0o700, recursive: true });
    await fs.chmod(this.baseDir, 0o700);
    const lockPayload: LockPayload = {
      workspaceFolders: payload.workspaceFolders,
      pid: process.pid,
      ideName: 'Obsidian',
      transport: 'ws',
      authToken: payload.authToken
    };

    const handle = await fs.open(filePath, 'w', 0o600);
    await handle.writeFile(Buffer.from(JSON.stringify(lockPayload, null, 2), 'utf8'));
    await handle.close();
    this.log(`lock file created: ${filePath}`);

    return filePath;
  }

  async stop(port: number): Promise<void> {
    const lockPath = this.getLockPath(port);
    await fs.unlink(lockPath).catch(() => undefined);
  }

  getLockPath(port: number): string {
    return path.join(this.baseDir, `${port}.lock`);
  }

  async listLocks(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.baseDir);
      return entries.filter((entry) => entry.endsWith('.lock')).map((entry) => path.join(this.baseDir, entry));
    } catch (error) {
      const err = error as { code?: string };
      if (err.code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  async readLock(lockPath: string): Promise<LockPayload | null> {
    try {
      const raw = await fs.readFile(lockPath, 'utf8');
      const parsed = JSON.parse(raw) as LockPayload;
      return parsed;
    } catch {
      return null;
    }
  }

  private async isPidAlive(pid: number): Promise<boolean> {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  async cleanupStaleLocks(): Promise<void> {
    const locks = await this.listLocks();
    await fs.mkdir(this.baseDir, { mode: 0o700, recursive: true });
    await fs.chmod(this.baseDir, 0o700);

    await Promise.all(
      locks.map(async (lockPath) => {
        const payload = await this.readLock(lockPath);
        if (!payload) {
          return;
        }
        if (payload.ideName !== 'Obsidian') {
          return;
        }
        const alive = await this.isPidAlive(payload.pid);
        if (!alive) {
          await fs.unlink(lockPath).catch(() => undefined);
          this.log(`removed stale lock: ${lockPath}`);
        }
      })
    );
  }
}

export async function ensureDirectoryMode700(dirPath: string): Promise<void> {
  try {
    await fs.mkdir(dirPath, { mode: 0o700, recursive: true });
  } catch {
    // handled by caller
  }
  await fs.chmod(dirPath, 0o700);
}
