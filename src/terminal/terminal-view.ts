import { ItemView, Platform } from 'obsidian';
import { Terminal, type ITheme } from 'xterm';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawnPtyProcess } from './pty';

export const TERMINAL_VIEW_TYPE = 'claude-ide-terminal';

export class TerminalView extends ItemView {
  private terminal: Terminal | null = null;
  private process: ReturnType<typeof spawnPtyProcess> | null = null;
  private titleFromChild = '';

  getViewType(): string {
    return TERMINAL_VIEW_TYPE;
  }

  getDisplayText(): string {
    return this.titleFromChild || 'Claude IDE';
  }

  async onOpen(): Promise<void> {
    this.contentEl.empty();

    const container = this.contentEl.createDiv({ cls: 'claude-ide-terminal' });
    this.terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: this.getMonospaceFont(),
      macOptionIsMeta: Platform.isMacOS,
      rightClickSelectsWord: Platform.isMacOS,
      allowProposedApi: true,
      fontSize: 13,
      fontWeight: '400',
      fontWeightBold: '700',
      lineHeight: 1.2,
      letterSpacing: 0,
      minimumContrastRatio: 4.5,
      theme: this.buildTheme()
    });
    this.terminal.open(container);

    const process = spawnPtyProcess(this.getBridgePath());
    if (!process) {
      this.terminal.write('Missing python bridge script.\r\n');
      return;
    }
    this.process = process;

    process.stdout.on('data', (chunk: string | Buffer) => {
      this.terminal?.write(Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk));
    });
    process.onExit(() => {
      this.leaf.detach();
    });

    this.terminal.attachCustomKeyEventHandler((event) => this.handleTerminalKeyEvent(event as KeyboardEvent));
    this.terminal.onTitleChange((title) => {
      this.titleFromChild = (title ?? '').trim();
      const titleElement = (this as { titleEl?: { setText: (title: string) => void } }).titleEl;
      if (titleElement) {
        titleElement.setText(this.getDisplayText());
      }
    });
    this.registerDomEvent(container, 'contextmenu', (event) => {
      void this.handleTerminalContextMenu(event);
    });

    this.terminal.onData((data) => {
      process.stdin.write(data);
    });

    this.terminal.onResize(({ cols, rows }) => {
      const message = JSON.stringify({ type: 'resize', cols, rows }) + '\n';
      process.stdin.write(message);
    });

    this.registerEvent(
      this.app.workspace.on('css-change', () => {
        this.updateTerminalTheme();
      })
    );

    this.updateTerminalTheme();
  }

  private buildTheme(): ITheme {
    const v = (name: string): string => getComputedStyle(document.body).getPropertyValue(name).trim();

    return {
      background: v('--background-primary'),
      foreground: v('--text-normal'),
      cursor: v('--text-accent'),
      cursorAccent: v('--background-primary'),
      selectionBackground: v('--text-selection'),
      black: v('--color-base-100'),
      red: v('--color-red'),
      green: v('--color-green'),
      yellow: v('--color-yellow'),
      blue: v('--color-blue'),
      magenta: v('--color-purple'),
      cyan: v('--color-cyan'),
      white: v('--text-normal'),
      brightBlack: v('--color-base-30'),
      brightRed: v('--color-red'),
      brightGreen: v('--color-green'),
      brightYellow: v('--color-yellow'),
      brightBlue: v('--color-blue'),
      brightMagenta: v('--color-purple'),
      brightCyan: v('--color-cyan'),
      brightWhite: v('--text-normal')
    };
  }

  private getMonospaceFont(): string {
    return getComputedStyle(document.body).getPropertyValue('--font-monospace').trim();
  }

  private updateTerminalTheme(): void {
    if (!this.terminal) {
      return;
    }

    this.terminal.options.theme = this.buildTheme();
    this.terminal.options.fontFamily = this.getMonospaceFont();
  }

  private async handleTerminalContextMenu(event: MouseEvent): Promise<void> {
    event.preventDefault();

    const selection = this.terminal?.getSelection() ?? '';
    if (selection) {
      await this.copyToClipboard(selection);
      this.terminal?.clearSelection();
      return;
    }

    await this.pasteFromClipboard();
  }

  private handleTerminalKeyEvent(event: KeyboardEvent): boolean {
    if (event.type !== 'keydown') {
      return true;
    }

    const copyModifier = Platform.isMacOS ? event.metaKey : (event.ctrlKey && event.shiftKey);
    const pasteModifier = Platform.isMacOS ? event.metaKey : (event.ctrlKey && event.shiftKey);

    if (copyModifier && event.code === 'KeyC') {
      const selection = this.terminal?.getSelection() ?? '';
      if (!selection) {
        return true;
      }
      void this.copyToClipboard(selection);
      return false;
    }

    if (pasteModifier && event.code === 'KeyV') {
      void this.pasteFromClipboard();
      return false;
    }

    return true;
  }

  private async copyToClipboard(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return;
    }
  }

  private async pasteFromClipboard(): Promise<void> {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        this.terminal?.paste(text);
      }
    } catch {
      return;
    }
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
      const devPath = path.join(__dirname, '..', 'terminal', 'pty-bridge.py');
      const legacyDevPath = path.join(__dirname, '..', 'scripts', 'pty-bridge.py');
      return existsSync(devPath) ? devPath : legacyDevPath;
    }

    const pluginRootPath = path.join(pluginDir, '.obsidian', 'plugins', 'claude-ide');
    const packagedPath = path.join(pluginRootPath, 'terminal', 'pty-bridge.py');
    const legacyPackagedPath = path.join(pluginRootPath, 'scripts', 'pty-bridge.py');

    return existsSync(packagedPath) ? packagedPath : legacyPackagedPath;
  }
}
