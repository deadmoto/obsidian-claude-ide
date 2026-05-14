import { App, FileView, MarkdownView, TFile, WorkspaceLeaf } from 'obsidian';
import { ClaudeIdeSettings } from './settings';
import { EventEmitter } from 'node:events';
import path from 'node:path';

export interface SelectionPayload {
  filePath?: string;
  selection?: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  } | null;
  text?: string;
}

export interface CurrentFilePayload {
  path: string;
  relativePath: string;
  language: string;
  content: string;
  isDirty: boolean;
  timestamp: string;
}

export class EditorStateAdapter extends EventEmitter {
  private activeLeaf: WorkspaceLeaf | null = null;
  private cache: Map<string, { content: string; timestamp: number; dirty: boolean }> = new Map();
  private watcher: ReturnType<typeof setInterval> | null = null;
  private lastResourcePath: string | null = null;
  private lastSelectionSignature: string = 'null';

  constructor(private readonly app: App, private readonly settings: ClaudeIdeSettings) {
    super();
  }

  startTracking(): void {
    if (this.watcher) {
      return;
    }
    this.watcher = setInterval(() => this.pollState(), 250);
  }

  stopTracking(): void {
    if (this.watcher) {
      clearInterval(this.watcher);
      this.watcher = null;
    }
  }

  setActiveLeaf(leaf: WorkspaceLeaf | null): void {
    this.activeLeaf = leaf;
    this.pollState();
  }

  updateSettings(settings: ClaudeIdeSettings): void {
    this.settings.shareUnsavedBuffer = settings.shareUnsavedBuffer;
    this.settings.maxFileBytes = settings.maxFileBytes;
  }

  async warmCache(): Promise<void> {
    const current = this.getCurrentMarkdownView();
    const file = current?.file;
    if (!file) {
      return;
    }
    const diskContent = await this.app.vault.cachedRead(file);
    this.cache.set(file.path, { content: diskContent, timestamp: Date.now(), dirty: false });
  }

  getCurrentFile(): CurrentFilePayload | null {
    const current = this.getCurrentMarkdownFile();
    if (!current) {
      return null;
    }

    const content = this.getCurrentContent(current.file);
    const cached = this.cache.get(current.file.path);

    return {
      path: this.resolveAbsolutePath(current.file.path),
      relativePath: current.file.path,
      language: current.file.extension === 'md' ? 'markdown' : 'plaintext',
      content: this.truncate(content),
      isDirty: current.isDirty,
      timestamp: new Date(cached?.timestamp || Date.now()).toISOString()
    };
  }

  getCurrentFilePath(): string | null {
    const current = this.getCurrentMarkdownFile();
    return current?.file.path || null;
  }

  getWorkspaceFolderPath(): string | null {
    const root = this.app.vault.getRoot();
    return (root as { path?: string }).path || (root as { getPath?: () => string }).getPath?.() || null;
  }

  getSelectionPayload(): SelectionPayload | null {
    const current = this.getCurrentMarkdownView();
    if (!current || !current.file) {
      return null;
    }

    const editor = (current as any).editor;
    const filePath = this.resolveAbsolutePath(current.file.path);

    if (!editor || typeof editor.getSelection !== 'function') {
      return {
        filePath,
        selection: null,
        text: ''
      };
    }

    const text = editor.getSelection?.() || '';
    if (!text) {
      return {
        filePath,
        selection: null,
        text: ''
      };
    }

    const from = this.normalizeCursor(editor, 'from');
    const to = this.normalizeCursor(editor, 'to');
    return {
      filePath,
      selection: {
        start: from,
        end: to
      },
      text
    };
  }

  getCurrentContent(file: TFile): string {
    const current = this.getCurrentMarkdownView();

    if (this.settings.shareUnsavedBuffer && current?.file?.path === file.path) {
      const editor = (current as any).editor;
      const live = editor?.getValue?.();
      if (typeof live === 'string') {
        return live;
      }
    }

    return this.cache.get(file.path)?.content ?? '';
  }

  async openFile(filePath: string): Promise<CurrentFilePayload | null> {
    const targetPath = filePath.startsWith('file://') ? filePath.replace(/^file:\/\//, '') : filePath;

    const vaultRoot = this.getWorkspaceFolderPath();
    if (!vaultRoot) {
      return null;
    }

    const relativePath = targetPath.startsWith(vaultRoot)
      ? targetPath.slice(vaultRoot.length + 1).replace(/^\/+/, '')
      : targetPath;

    const file = this.app.vault.getAbstractFileByPath(relativePath);
    if (!(file instanceof TFile)) {
      return null;
    }

    (await this.app.workspace.getLeaf(true) as WorkspaceLeaf).openFile?.(file);
    this.pollState();
    const content = await this.app.vault.cachedRead(file);
    this.cache.set(file.path, { content, timestamp: Date.now(), dirty: false });

    return {
      path: this.resolveAbsolutePath(file.path),
      relativePath: file.path,
      language: file.extension === 'md' ? 'markdown' : 'plaintext',
      content,
      isDirty: false,
      timestamp: new Date().toISOString()
    };
  }

  private getCurrentMarkdownView(): MarkdownView | null {
    const view = this.activeLeaf ? this.activeLeaf.view : this.app.workspace.getActiveViewOfType(MarkdownView);
    return view && (view as any).file ? (view as unknown as MarkdownView) : null;
  }

  private getCurrentMarkdownFile(): { file: TFile; isDirty: boolean } | null {
    const view = this.getCurrentMarkdownView();
    if (!view?.file || typeof view.file.path !== 'string') {
      return null;
    }

    const file = view.file;
    const cache = this.cache.get(file.path);

    let isDirty = false;
    const leafState = this.app.workspace.getLeavesOfType('markdown').find((leaf) => {
      const fileView = leaf.view as FileView;
      return fileView?.file?.path === file.path;
    });

    const dirtyFromView = (leafState as any)?.view?.isDirty;
    if (typeof dirtyFromView === 'boolean') {
      isDirty = dirtyFromView;
    }

    return { file: view.file, isDirty: isDirty || Boolean(cache && cache.dirty) };
  }

  private pollState(): void {
    const current = this.getCurrentMarkdownFile();
    const currentPath = current?.file.path ?? null;

    if (currentPath !== this.lastResourcePath) {
      this.lastResourcePath = currentPath;
      this.emit('resources/listChanged', currentPath);
      this.emit('selection/changed', null);
    }

    const selection = this.getSelectionPayload();
    const signature = selection ? JSON.stringify(selection) : 'null';
    if (signature !== this.lastSelectionSignature) {
      this.lastSelectionSignature = signature;
      this.emit('selection/changed', selection);
    }

    if (current && current.file.path) {
      const content = this.getCurrentContent(current.file);
      const cache = this.cache.get(current.file.path);
      const isDirty = current.isDirty;
      if (!cache || cache.content !== content || cache.dirty !== isDirty) {
        this.cache.set(current.file.path, { content, timestamp: Date.now(), dirty: isDirty });
        this.emit('resources/updated', this.resolveFileUri(current.file.path));
      }
    }
  }

  private resolveFileUri(filePath: string): string {
    return `file://${this.resolveAbsolutePath(filePath)}`;
  }

  private resolveAbsolutePath(relativePath: string): string {
    const root = this.getWorkspaceFolderPath();
    if (!root) {
      return relativePath;
    }
    return path.join(root, relativePath);
  }

  private normalizeCursor(editor: { getCursor: (to?: 'to' | 'from') => { line: number; ch: number } | null }, kind: 'to' | 'from'): {
    line: number;
    character: number;
  } {
    if (!editor || typeof editor.getCursor !== 'function') {
      return { line: 0, character: 0 };
    }

    const cursor = editor.getCursor(kind) || { line: 0, ch: 0 };
    return {
      line: cursor.line + 1,
      character: cursor.ch + 1
    };
  }

  private truncate(content: string): string {
    if (content.length <= this.settings.maxFileBytes) {
      return content;
    }

    const clipped = content.slice(0, this.settings.maxFileBytes);
    return `[File truncated for IDE context: first ${this.settings.maxFileBytes} bytes only]\n${clipped}`;
  }
}
