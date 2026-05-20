import { ItemView, Platform, WorkspaceLeaf } from 'obsidian';
import { Terminal, type ITheme } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawnPtyProcess, PtyProcess } from './pty';

export const TERMINAL_VIEW_TYPE = 'claude-ide-terminal';

export interface TerminalViewOptions {
  getCommand?: () => string;
  getCwd?: () => string | null;
}

export class TerminalView extends ItemView {
  private terminal: Terminal | null = null;
  private process: PtyProcess | null = null;
  private titleFromChild = '';
  private fitAddon: FitAddon | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private opts: TerminalViewOptions;

  constructor(leaf: WorkspaceLeaf, opts: TerminalViewOptions = {}) {
    super(leaf);
    this.opts = opts;
  }

  getViewType(): string {
    return TERMINAL_VIEW_TYPE;
  }

  getDisplayText(): string {
    return this.titleFromChild || 'Claude IDE';
  }

  onResize(): void {
    this.refit();
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
    this.fitAddon = new FitAddon();
    this.terminal.loadAddon(this.fitAddon);
    this.fitAddon.fit();

    const { cols, rows } = this.terminal;
    const command = (this.opts.getCommand?.() ?? '').trim() || undefined;
    const cwd = this.opts.getCwd?.() ?? undefined;
    const proc = spawnPtyProcess(this.getBridgePath(), { cols, rows, command, cwd });
    if (!proc) {
      this.terminal.write('Missing python bridge script.\r\n');
      return;
    }
    this.process = proc;

    proc.stdout.on('data', (chunk: string | Buffer) => {
      this.terminal?.write(Buffer.isBuffer(chunk) ? chunk : String(chunk));
    });
    // Surface bridge errors in the terminal — otherwise child crashes are invisible.
    proc.stderr.on('data', (chunk: string | Buffer) => {
      this.terminal?.write(Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk));
    });
    proc.onExit(() => {
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
      proc.stdin.write(data);
    });

    this.terminal.onResize(({ cols, rows }) => {
      proc.writeResize(rows, cols);
    });

    this.registerEvent(
      this.app.workspace.on('css-change', () => {
        this.updateTerminalTheme();
      })
    );
    this.registerEvent(
      this.app.workspace.on('layout-change', () => {
        this.refit();
      })
    );
    this.registerEvent(
      (this.app.workspace as any).on('active-leaf-change', (leaf: any) => {
        if (leaf === this.leaf) {
          this.refit();
        }
      })
    );

    this.resizeObserver = new ResizeObserver(() => this.refit());
    this.resizeObserver.observe(container);

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

  private refit(): void {
    requestAnimationFrame(() => {
      this.fitAddon?.fit();
    });
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
    this.fitAddon?.dispose();
    this.fitAddon = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.terminal?.dispose();
    this.terminal = null;
  }

  private getBridgePath(): string {
    const vaultDir = (this.app.vault.adapter as any)?.basePath;
    const pluginId = 'obsidian-claude-ide';

    if (!vaultDir) {
      const devPath = path.join(__dirname, '..', 'terminal', 'pty-bridge.py');
      return devPath;
    }

    const pluginRoot = path.join(vaultDir, '.obsidian', 'plugins', pluginId);
    const candidates = [
      path.join(pluginRoot, 'pty-bridge.py'),
      path.join(pluginRoot, 'terminal', 'pty-bridge.py'),
      path.join(pluginRoot, 'scripts', 'pty-bridge.py')
    ];
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
    // Falls through to spawnPtyProcess's inlined-script fallback.
    return candidates[0];
  }
}
