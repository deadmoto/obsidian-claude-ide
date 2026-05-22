import * as crypto from 'node:crypto';
import { Editor, MarkdownView, Notice, Plugin, TFile, WorkspaceLeaf } from 'obsidian';
import { EditorView } from '@codemirror/view';
import { cleanStaleLocks, deleteLockFile, writeLockFile } from './bridge/discovery';
import { EditorStateAdapter } from './editor/state';
import { WsAdapter } from './bridge/ws-adapter';
import { ClaudeIdeSettingTab, ClaudeIdeSettings, DEFAULT_SETTINGS } from './settings';
import { TERMINAL_VIEW_TYPE, TerminalView } from './terminal/terminal-view';

export default class ClaudeIdePlugin extends Plugin {
  settings: ClaudeIdeSettings = DEFAULT_SETTINGS;
  private bridge: WsAdapter | null = null;
  private adapter: EditorStateAdapter | null = null;
  private running = false;
  /** Last filePath we've emitted selection_changed for. Guards against rapid
   *  no-op leaf-change events spamming the bridge. */
  private lastNotifiedFilePath = '';

  async onload(): Promise<void> {
    await this.loadSettings();
    this.adapter = new EditorStateAdapter(this.app, this.settings);
    this.adapter.updateSettings(this.settings);
    this.addSettingTab(new ClaudeIdeSettingTab(this.app, this));
    this.registerView(TERMINAL_VIEW_TYPE, (leaf) => new TerminalView(leaf, {
      getCommand: () => this.settings.claudeCommand,
      getCwd: () => this.adapter?.getWorkspaceFolderPath() ?? null
    }));

    this.addCommand({
      id: 'open-claude-in-integrated-terminal',
      name: 'Claude IDE: Open Claude in Integrated Terminal',
      callback: async () => {
        await this.openTerminal('new-tab');
      }
    });

    // ── File / cursor tracking ────────────────────────────────────────────────
    //
    // Three event sources drive selection_changed pushes:
    //
    //   1. active-leaf-change on a MarkdownView → synthetic 1-char range push
    //      to populate ideSelection.filePath with the new file. Guarded by
    //      lastNotifiedFilePath so rapid focus shuffles don't spam.
    //   2. CM6 EditorView.updateListener → real (line, character) coords on
    //      every selectionSet (cursor click, arrow key, drag-select).
    //   3. editor-change → refresh content cache; emit resource_updated for
    //      subscribed URIs so Claude sees live edits to the file body.
    //
    // No background polling. All three fire synchronously off Obsidian's own
    // events — no 250ms latency, no battery wakeups, no signature dedup races.

    this.registerEvent(
      (this.app.workspace as any).on('active-leaf-change', (leaf: WorkspaceLeaf | null) => {
        // Only react when focus lands on a real markdown view. Otherwise
        // (terminal pane, sidebars, settings tab) the previously-tracked file
        // and selection must survive the focus change so Claude keeps showing
        // "⧉ In file.md" while the user types in the terminal.
        const view = leaf?.view;
        if (!(view instanceof MarkdownView) || !view.file) return;
        this.adapter?.setActiveLeaf(leaf);
        this.notifyFileChanged(view.file);
      })
    );

    this.registerEditorExtension([
      EditorView.updateListener.of((update) => {
        if (!update.selectionSet) return;
        if (!this.running || !this.bridge) return;
        const adapter = this.adapter;
        if (!adapter) return;
        const file = adapter.getCurrentMarkdownTFile();
        if (!file) return;

        const sel = update.state.selection.main;
        const fromLine = update.state.doc.lineAt(sel.from);
        const filePath = adapter.resolveFileUri(file.path).replace(/^file:\/\//, '');

        if (sel.empty) {
          const line = fromLine.number - 1;       // CM6 is 1-indexed → 0-indexed
          const character = sel.head - fromLine.from;
          this.bridge.emitSelectionChanged({
            filePath,
            selection: {
              start: { line, character },
              end:   { line, character: character + 1 }
            }
          });
        } else {
          const toLine = update.state.doc.lineAt(sel.to);
          const text = update.state.sliceDoc(sel.from, sel.to);
          this.bridge.emitSelectionChanged({
            filePath,
            selection: {
              start: { line: fromLine.number - 1, character: sel.from - fromLine.from },
              end:   { line: toLine.number - 1,   character: sel.to   - toLine.from }
            },
            text
          });
        }
      })
    ]);

    this.registerEvent(
      (this.app.workspace as any).on('editor-change', (_editor: Editor, info: { file?: TFile }) => {
        if (!this.running || !this.bridge || !this.adapter) return;
        const file = info?.file;
        if (!(file instanceof TFile)) return;
        // Refresh content cache so getCurrentFile snapshots include unsaved
        // edits, then nudge any subscribed resource consumer.
        this.adapter.refreshCache(file).catch(() => undefined);
        this.bridge.emitResourceUpdated(this.adapter.resolveFileUri(file.path));
      })
    );

    this.registerEvent(
      (this.app.workspace as any).on('quit', () => {
        this.stopBridge().catch(() => undefined);
      })
    );

    if (this.settings.autoStartBridge) {
      await this.startBridge();
    }

    if (this.settings.autoOpenTerminal !== 'disabled') {
      await this.openTerminal(this.settings.autoOpenTerminal);
    }
  }

  private notifyFileChanged(file: TFile): void {
    if (!this.running || !this.bridge || !this.adapter) return;
    const payload = this.adapter.buildFileChangedPayload(file);
    if (payload.filePath === this.lastNotifiedFilePath) return;
    this.lastNotifiedFilePath = payload.filePath ?? '';
    this.bridge.emitSelectionChanged(payload);
  }

  private async openTerminal(location: 'right-split' | 'bottom-split' | 'new-tab'): Promise<WorkspaceLeaf> {
    const existing = this.app.workspace.getLeavesOfType(TERMINAL_VIEW_TYPE);
    if (existing.length) {
      const leaf = existing[0];
      this.app.workspace.revealLeaf(leaf);
      return leaf;
    }

    let leaf: WorkspaceLeaf | null;
    if (location === 'right-split') {
      leaf = this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getLeaf('tab');
    } else if (location === 'bottom-split') {
      leaf = this.app.workspace.getLeaf('split', 'horizontal') ?? this.app.workspace.getLeaf('tab');
    } else {
      leaf = this.app.workspace.getLeaf('tab');
    }

    if (!leaf) {
      throw new Error('Unable to allocate a leaf for terminal');
    }

    await leaf.setViewState({
      type: TERMINAL_VIEW_TYPE,
      active: true,
      state: {}
    });

    this.app.workspace.revealLeaf(leaf);
    return leaf;
  }

  onunload(): void {
    this.stopBridge().catch(() => undefined);
  }

  async loadSettings(): Promise<void> {
    const loaded = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded ?? {});
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  syncEditorSettings(): void {
    this.adapter?.updateSettings(this.settings);
  }

  isBridgeRunning(): boolean {
    return this.running && this.bridge?.isStarted() === true;
  }

  async startBridge(): Promise<void> {
    if (this.running || this.bridge) {
      return;
    }

    const adapter = this.ensureAdapter();
    await adapter.warmCache();
    const workspaceFolder = adapter.getWorkspaceFolderPath();
    if (!workspaceFolder) {
      throw new Error('No active vault to start bridge');
    }

    const token = crypto.randomBytes(32).toString('hex');
    const bridge = new WsAdapter(
      {
        authToken: token,
        workspaceFolder,
        debug: this.settings.debugLogging
      },
      adapter,
      (message) => this.log(message)
    );

    try {
      const removedLocks = await cleanStaleLocks();
      for (const port of removedLocks) {
        this.notify(`cleared stale lock for :${port}`);
      }

      const port = await bridge.start();
      await writeLockFile(port, {
        workspaceFolders: [workspaceFolder],
        authToken: token
      });

      this.bridge = bridge;
      this.running = true;

      // Seed Claude with the current file immediately, before any user
      // gesture, so "⧉ In file.md" shows up on first connection.
      const initial = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (initial?.file) {
        this.notifyFileChanged(initial.file);
      }

      this.notify(`bridge started on :${port}`);
    } catch (error) {
      const port = bridge.port;
      this.notify(`bridge failed to start — ${(error as Error).message ?? String(error)}`, 'error');
      await bridge.stop();
      if (port > 0) {
        await deleteLockFile(port).catch(() => undefined);
      }
      throw error;
    }
  }

  async stopBridge(): Promise<void> {
    if (!this.bridge) {
      return;
    }

    const bridge = this.bridge;
    const port = bridge.port;
    this.bridge = null;
    this.running = false;
    this.lastNotifiedFilePath = '';

    await bridge.stop().catch(() => undefined);
    await deleteLockFile(port).catch(() => undefined);
    this.notify('bridge stopped');
  }

  private log(message: string): void {
    console.log(`[Claude IDE] ${message}`);
  }

  private notify(message: string, level: 'info' | 'error' = 'info'): void {
    this.log(message);
    if (level === 'error') {
      new Notice(`Claude IDE: ${message}`, 0);
      return;
    }

    if (this.settings.debugLogging) {
      new Notice(`Claude IDE: ${message}`, 3000);
    }
  }

  private ensureAdapter(): EditorStateAdapter {
    if (!this.adapter) {
      throw new Error('Editor adapter is not initialized yet');
    }
    return this.adapter;
  }
}
