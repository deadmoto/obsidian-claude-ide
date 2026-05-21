export class Plugin {
  app: any;
  constructor(app?: any) {
    this.app = app;
  }
  registerEvent() {}
  registerView() {}
  addCommand() {}
  addSettingTab() {}
  saveData() {
    return Promise.resolve();
  }
  loadData() {
    return Promise.resolve(null);
  }
}

export class ItemView {
  app: any;
  contentEl: any = {
    empty: () => {},
    createDiv: (opts?: { cls?: string }) => {
      const container: any = {
        write: () => {},
        on: () => {}
      };
      return container;
    }
  };

  getViewType() {
    return '';
  }
  getDisplayText() {
    return '';
  }
}

export class PluginSettingTab {
  containerEl: any = { empty: () => {} };
  constructor(_app: any, _plugin: any) {}
}

export class Setting {
  constructor(_containerEl: any) {}
  setName() {
    return this;
  }
  setDesc() {
    return this;
  }
  addText() {
    return this;
  }
  addToggle() {
    return this;
  }
}

export class MarkdownView {
  file: any;
  editor: any;
}

export class TFile {
  path = '';
}

export class FileView {
  file: any;
}

export class FileSystemAdapter {
  private base: string;
  constructor(base = '/tmp/mock-vault') {
    this.base = base;
  }
  getBasePath(): string {
    return this.base;
  }
}

export interface App {}
export type WorkspaceLeaf = any;
export const Platform = { isMacOS: process.platform === 'darwin' };
