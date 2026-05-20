import { ChildProcessByStdio, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { PTY_BRIDGE_SCRIPT } from './pty-bridge-script';

export interface PtyProcess {
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  writeResize: (rows: number, cols: number) => void;
  kill: () => void;
  onExit: (callback: (code: number | null) => void) => void;
}

export interface PtySpawnOptions {
  /** Initial xterm columns. Defaults to 80. */
  cols?: number;
  /** Initial xterm rows. Defaults to 24. */
  rows?: number;
  /** Command to run inside a login shell (e.g. "claude"). */
  command?: string;
  /** Working directory for the spawned shell. */
  cwd?: string;
}

/**
 * Launches the Python PTY bridge with 4 stdio pipes (stdin, stdout, stderr, cmdio).
 *
 * The cmdio pipe (fd 3) is used to send "<rows>x<cols>\n" resize control frames
 * out-of-band, so they never appear as keystrokes to the child shell.
 */
export function spawnPtyProcess(scriptPath: string, opts: PtySpawnOptions = {}): PtyProcess | null {
  let resolvedScriptPath = scriptPath;

  if (!resolvedScriptPath || !fs.existsSync(resolvedScriptPath)) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-ide-pty-'));
    resolvedScriptPath = path.join(tempDir, 'pty-bridge.py');
    fs.writeFileSync(resolvedScriptPath, PTY_BRIDGE_SCRIPT, 'utf8');
  }

  if (!fs.existsSync(resolvedScriptPath)) {
    return null;
  }

  const cols = opts.cols ?? 80;
  const rows = opts.rows ?? 24;

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PYTHONUNBUFFERED: '1',
    PTY_COLS: String(cols),
    PTY_ROWS: String(rows)
  };
  if (opts.command) {
    env.CLAUDE_IDE_CMD = opts.command;
  }

  const child: ChildProcessByStdio<Writable, Readable, Readable> = spawn(
    'python3',
    [resolvedScriptPath, '--session-id', randomUUID()],
    {
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      cwd: opts.cwd,
      env
    }
  ) as unknown as ChildProcessByStdio<Writable, Readable, Readable>;

  const cmdio = child.stdio[3] as unknown as Writable | null;

  return {
    stdin: child.stdin!,
    stdout: child.stdout!,
    stderr: child.stderr!,
    writeResize: (rows: number, cols: number) => {
      if (cmdio && !cmdio.destroyed) {
        cmdio.write(`${rows}x${cols}\n`);
      }
    },
    kill: () => {
      try { child.kill(); } catch { /* already gone */ }
    },
    onExit: (callback) => {
      child.on('exit', (code) => callback(code));
    }
  };
}
