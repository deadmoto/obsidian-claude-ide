import { App, FileSystemAdapter, FileView, MarkdownView, TFile, WorkspaceLeaf } from 'obsidian';
import { CurrentFilePayload, SelectionPayload } from '../bridge/types';
import { ClaudeIdeSettings } from '../settings';
import path from 'node:path';

/**
 * Read-only view onto Obsidian's editor / vault state. Used by the WS adapter
 * for on-demand snapshots (tool calls, resource reads) and by main.ts to
 * compute payloads for event-driven selection_changed pushes.
 *
 * No background polling. All notification firing is owned by main.ts which
 * subscribes to active-leaf-change, CM6 selection updates, and editor-change
 * events directly.
 */
export class EditorStateAdapter {
  private activeLeaf: WorkspaceLeaf | null = null;
  private cache: Map<string, { content: string; timestamp: number; dirty: boolean }> = new Map();

  constructor(private readonly app: App, private readonly settings: ClaudeIdeSettings) {}

  setActiveLeaf(leaf: WorkspaceLeaf | null): void {
    this.activeLeaf = leaf;
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

  /**
   * Update the cache for a specific file from its current on-disk (or live
   * buffer, when sharing unsaved edits) contents. Called from main.ts on
   * editor-change so resource subscribers see fresh content.
   */
  async refreshCache(file: TFile): Promise<void> {
    const view = this.getCurrentMarkdownView();
    const live = this.settings.shareUnsavedBuffer && view?.file?.path === file.path
      ? (view as any).editor?.getValue?.()
      : null;
    const content = typeof live === 'string' ? live : await this.app.vault.cachedRead(file);
    this.cache.set(file.path, { content, timestamp: Date.now(), dirty: typeof live === 'string' });
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

  getCurrentMarkdownTFile(): TFile | null {
    return this.getCurrentMarkdownFile()?.file ?? null;
  }

  getWorkspaceFolderPath(): string | null {
    // Absolute filesystem path of the vault. vault.getRoot().path returns "/"
    // (the vault-relative root), which breaks both the terminal cwd and
    // Claude's getWorkspaceFolders — so claude --ide treats `/` as the repo.
    const adapter = this.app.vault.adapter;
    if (adapter instanceof FileSystemAdapter) {
      return adapter.getBasePath();
    }
    return null;
  }

  /**
   * Synchronous snapshot of the current selection state. Used by the WS
   * adapter for compensation pushes after initialize / tools/list /
   * resources/list (mU7 hook re-population).
   *
   * Claude Code's mU7 hook ignores selection_changed unless a real
   * {start,end} range is present. Always emit at least a 1-character range
   * so ideSelection.filePath is populated, driving the "⧉ In file.md"
   * display even when no text is selected.
   *
   * Omit `text` when no text is selected — sending text: '' alongside the
   * synthetic range made the hook clear ideSelection on the post-response
   * compensation push, producing the "blink" on tab switches.
   */
  getSelectionPayload(): SelectionPayload | null {
    const current = this.getCurrentMarkdownView();
    if (!current || !current.file) {
      return null;
    }

    const editor = (current as any).editor;
    const filePath = this.resolveAbsolutePath(current.file.path);

    if (!editor || typeof editor.getSelection !== 'function') {
      return this.synthSelectionPayload(filePath);
    }

    const text = editor.getSelection?.() || '';
    const from = this.normalizeCursor(editor, 'from');

    if (!text) {
      return {
        filePath,
        selection: {
          start: from,
          end:   { line: from.line, character: from.character + 1 }
        }
      };
    }

    const to = this.normalizeCursor(editor, 'to');
    return {
      filePath,
      selection: { start: from, end: to },
      text
    };
  }

  /**
   * Synthetic 1-char selection at (0,0). Used by main.ts on active-leaf-change
   * to populate ideSelection with the new file's path without claiming a
   * specific cursor position — the CM6 listener will follow up with real
   * coords once the user actually moves the cursor in the new view.
   */
  buildFileChangedPayload(file: TFile): SelectionPayload {
    return this.synthSelectionPayload(this.resolveAbsolutePath(file.path));
  }

  private synthSelectionPayload(filePath: string): SelectionPayload {
    return {
      filePath,
      selection: {
        start: { line: 0, character: 0 },
        end:   { line: 0, character: 1 }
      }
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

  resolveFileUri(filePath: string): string {
    return `file://${this.resolveAbsolutePath(filePath)}`;
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

    // Obsidian's Editor API is 0-indexed and we keep it that way to match
    // CM6 / LSP / VSCode conventions on the wire.
    const cursor = editor.getCursor(kind) || { line: 0, ch: 0 };
    return {
      line: cursor.line,
      character: cursor.ch
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
