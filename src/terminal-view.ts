import { ItemView, WorkspaceLeaf } from 'obsidian';
import { Terminal } from 'xterm';
import path from 'node:path';
import { spawnPtyProcess } from './terminal';

export const TERMINAL_VIEW_TYPE = 'claude-ide-terminal';

export class TerminalView extends ItemView {
  private terminal: Terminal | null = null;
  private process: ReturnType<typeof spawnPtyProcess> | null = null;

  getViewType(): string {
    return TERMINAL_VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'Claude IDE';
  }

  async onOpen(): Promise<void> {
    this.contentEl.empty();

    const container = this.contentEl.createDiv({ cls: 'claude-ide-terminal' });
    this.terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: 'monospace'
    });
    this.terminal.open(container);
    this.terminal.write('Starting PTY bridge...\r\n');

    const process = spawnPtyProcess(this.getBridgePath());
    if (!process) {
      this.terminal.write('Missing python bridge script.\r\n');
      return;
    }
    this.process = process;

    process.stdout.on('data', (chunk: string | Buffer) => {
      this.terminal?.write(Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk));
    });

    this.terminal.onData((data) => {
      process.stdin.write(data);
    });

    this.terminal.onResize(({ cols, rows }) => {
      const message = JSON.stringify({ type: 'resize', cols, rows }) + '\n';
      process.stdin.write(message);
    });
  }

  async onClose(): Promise<void> {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    this.terminal?.dispose();
    this.terminal = null;
  }

  private getBridgePath(): string {
    const pluginDir = (this.app.vault.adapter as any)?.basePath;
    if (!pluginDir) {
      return path.join(__dirname, '..', 'scripts', 'pty-bridge.py');
    }
    return path.join(pluginDir, '.obsidian', 'plugins', 'claude-ide', 'scripts', 'pty-bridge.py');
  }
}

export async function openTerminalInLeaf(leaf: WorkspaceLeaf): Promise<void> {
  await leaf.setViewState({
    type: TERMINAL_VIEW_TYPE,
    active: true,
    state: {}
  });
}
