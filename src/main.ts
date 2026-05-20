import * as crypto from 'node:crypto';
import { Plugin, WorkspaceLeaf } from 'obsidian';
import { deleteLockFile, writeLockFile } from './bridge/discovery';
import { EditorStateAdapter } from './editor/state';
import { WsAdapter } from './bridge/ws-adapter';
import { ClaudeIdeSettingTab, ClaudeIdeSettings, DEFAULT_SETTINGS } from './settings';
import { TERMINAL_VIEW_TYPE, TerminalView } from './terminal/terminal-view';

export default class ClaudeIdePlugin extends Plugin {
  settings: ClaudeIdeSettings = DEFAULT_SETTINGS;
  private bridge: WsAdapter | null = null;
  private adapter: EditorStateAdapter | null = null;
  private running = false;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.adapter = new EditorStateAdapter(this.app, this.settings);

    this.adapter.updateSettings(this.settings);
    this.addSettingTab(new ClaudeIdeSettingTab(this.app, this));
    this.registerView(TERMINAL_VIEW_TYPE, (leaf) => new TerminalView(leaf));

    this.addCommand({
      id: 'open-claude-in-integrated-terminal',
      name: 'Claude IDE: Open Claude in Integrated Terminal',
      callback: async () => {
        await this.openTerminal('new-tab');
      }
    });

    this.registerEvent(
      (this.app.workspace as any).on('active-leaf-change', (leaf: WorkspaceLeaf) => {
        this.adapter?.setActiveLeaf(leaf);
        this.bridge?.emitResourcesListChanged();
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
        workspaceFolder
      },
      adapter,
      (message) => this.log(message)
    );

    try {
      const port = await bridge.start();
      await writeLockFile(port, {
        workspaceFolders: [workspaceFolder],
        authToken: token
      });

      this.bridge = bridge;
      this.adapter?.startTracking({
        onResourcesListChanged: () => {
          this.bridge?.emitResourcesListChanged();
        },
        onSelectionChanged: (payload) => {
          this.bridge?.emitSelectionChanged(payload);
        },
        onResourceUpdated: (uri) => {
          this.bridge?.emitResourceUpdated(uri);
        }
      });
      this.running = true;

      this.bridge.emitResourcesListChanged();
      this.bridge.emitSelectionChanged(adapter.getSelectionPayload());

      if (this.settings.autoLaunchClaudeWithIde) {
        this.log('autoLaunchClaudeWithIde is enabled but not yet implemented.');
      }
    } catch (error) {
      const port = bridge.port;
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
    this.ensureAdapter().stopTracking();

    await bridge.stop().catch(() => undefined);
    await deleteLockFile(port).catch(() => undefined);
  }

  private log(message: string): void {
    if (this.settings.debugLogging) {
      console.log(`[Claude IDE] ${message}`);
    }
  }

  private ensureAdapter(): EditorStateAdapter {
    if (!this.adapter) {
      throw new Error('Editor adapter is not initialized yet');
    }
    return this.adapter;
  }
}
