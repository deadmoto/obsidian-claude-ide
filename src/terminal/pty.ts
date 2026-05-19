import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { PTY_BRIDGE_SCRIPT } from './pty-bridge-script';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export interface PtyProcess {
  stdin: fs.WriteStream;
  stdout: fs.ReadStream;
  stderr: fs.ReadStream;
  extra: fs.ReadStream;
  kill: () => void;
}

/**
 * Launches a Python PTY bridge with 4 stdio pipes (stdin, stdout, stderr, extra).
 */
export function spawnPtyProcess(scriptPath: string): PtyProcess | null {
  let resolvedScriptPath = scriptPath;

  if (!resolvedScriptPath || !fs.existsSync(resolvedScriptPath)) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-ide-pty-'));
    resolvedScriptPath = path.join(tempDir, 'pty-bridge.py');
    fs.writeFileSync(resolvedScriptPath, PTY_BRIDGE_SCRIPT, 'utf8');
  }

  if (!fs.existsSync(resolvedScriptPath)) {
    return null;
  }

  const child = spawn('python3', [resolvedScriptPath, '--session-id', randomUUID()], {
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PYTHONUNBUFFERED: '1'
    }
  });

  return {
    stdin: child.stdin as fs.WriteStream,
    stdout: child.stdout as fs.ReadStream,
    stderr: child.stderr as fs.ReadStream,
    extra: child.stdio[3] as unknown as fs.ReadStream,
    kill: () => child.kill()
  };
}
