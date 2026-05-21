import { App, Plugin, PluginSettingTab, Setting } from 'obsidian';
import type ClaudeIdePlugin from './main';

export interface ClaudeIdeSettings {
  claudeCommand: string;
  autoStartBridge: boolean;
  autoOpenTerminal: 'disabled' | 'bottom-split' | 'right-split' | 'new-tab';
  shareUnsavedBuffer: boolean;
  maxFileBytes: number;
  debugLogging: boolean;
}

export const DEFAULT_SETTINGS: ClaudeIdeSettings = {
  claudeCommand: 'claude',
  autoStartBridge: true,
  autoOpenTerminal: 'disabled',
  shareUnsavedBuffer: true,
  maxFileBytes: 200000,
  debugLogging: false
};

export class ClaudeIdeSettingTab extends PluginSettingTab {
  plugin: ClaudeIdePlugin;

  constructor(app: App, plugin: ClaudeIdePlugin) {
    super(app, plugin as unknown as Plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName('Claude command')
      .setDesc('Executable used to launch Claude Code, defaults to `claude`.')
      .addText((text) =>
        text
          .setPlaceholder('claude')
          .setValue(this.plugin.settings.claudeCommand)
          .onChange(async (value) => {
            this.plugin.settings.claudeCommand = value || 'claude';
            await this.persist();
          })
      );

    new Setting(containerEl)
      .setName('Auto-start bridge')
      .setDesc('Start the MCP bridge when the plugin loads.')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoStartBridge)
          .onChange(async (value) => {
            this.plugin.settings.autoStartBridge = value;
            await this.persist();
            if (value && !this.plugin.isBridgeRunning()) {
              await this.plugin.startBridge();
            }
            if (!value) {
              await this.plugin.stopBridge();
            }
            this.plugin.syncEditorSettings();
          })
      );

    new Setting(containerEl)
      .setName('Launch Claude Terminal on Start')
      .setDesc('Open a Claude terminal pane automatically when the plugin loads.')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('disabled', 'Disabled')
          .addOption('bottom-split', 'Bottom split')
          .addOption('right-split', 'Right split')
          .addOption('new-tab', 'New tab')
          .setValue(this.plugin.settings.autoOpenTerminal)
          .onChange(async (value) => {
            this.plugin.settings.autoOpenTerminal = value as ClaudeIdeSettings['autoOpenTerminal'];
            await this.persist();
            this.plugin.syncEditorSettings();
          })
      );

    new Setting(containerEl)
      .setName('Share unsaved buffer')
      .setDesc('Prefer unsaved editor buffer over file on disk.')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.shareUnsavedBuffer)
          .onChange(async (value) => {
            this.plugin.settings.shareUnsavedBuffer = value;
            await this.persist();
            this.plugin.syncEditorSettings();
          })
      );

    new Setting(containerEl)
      .setName('Max file bytes')
      .setDesc('Maximum bytes to include for IDE context.')
      .addText((text) =>
        text
          .setPlaceholder('200000')
          .setValue(String(this.plugin.settings.maxFileBytes))
          .onChange(async (value) => {
            const parsed = Number.parseInt(value, 10);
            this.plugin.settings.maxFileBytes = Number.isFinite(parsed) && parsed > 0 ? parsed : 200000;
            await this.persist();
            this.plugin.syncEditorSettings();
          })
      );

    new Setting(containerEl)
      .setName('Debug logging')
      .setDesc('Enable verbose logging to the console.')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.debugLogging)
          .onChange(async (value) => {
            this.plugin.settings.debugLogging = value;
            await this.persist();
            this.plugin.syncEditorSettings();
          })
      );
  }

  private async persist(): Promise<void> {
    if (this.plugin.saveSettings) {
      await this.plugin.saveSettings();
      return;
    }
    await this.plugin.saveData(this.plugin.settings);
  }
}
