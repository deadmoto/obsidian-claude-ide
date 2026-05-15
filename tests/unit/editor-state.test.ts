import { describe, it, expect } from 'vitest';
import { EditorStateAdapter } from '../../src/editor-state';
import { DEFAULT_SETTINGS } from '../../src/settings';

const mkApp = () => {
  const markdownView = {
    file: { path: 'notes/test.md', extension: 'md' } as any,
    editor: {
      getValue: () => 'line1\nline2\nline3',
      getSelection: () => 'line2',
      getCursor: (kind?: 'to' | 'from') => {
        return kind === 'to' ? { line: 1, ch: 5 } : { line: 1, ch: 0 };
      }
    }
  };

  const workspace = {
    getActiveViewOfType: () => markdownView,
    getLeavesOfType: () => [{ view: markdownView }],
    getLeaf: () => ({ openFile: async () => undefined }),
    openLinkText: async () => undefined
  } as any;

  const vault = {
    cachedRead: async () => 'cached line',
    getAbstractFileByPath: () => ({ path: 'notes/test.md', extension: 'md' }),
    getRoot: () => ({ path: '/tmp/vault' })
  } as any;

  const app = { vault, workspace } as any;

  return { app, markdownView };
};

describe('EditorStateAdapter', () => {
  it('returns current file payload and truncates large files', async () => {
    const { app } = mkApp();
    const adapter = new EditorStateAdapter(app as any, { ...DEFAULT_SETTINGS, maxFileBytes: 8 });

    await adapter.warmCache();
    const second = adapter.getCurrentFile();

    expect(second).not.toBeNull();
    expect(second?.relativePath).toBe('notes/test.md');
    expect(second?.content.startsWith('[File truncated for IDE context')).toBe(true);
  });

  it('builds selection payload from current view', () => {
    const { app } = mkApp();
    const adapter = new EditorStateAdapter(app as any, DEFAULT_SETTINGS);
    const selection = adapter.getSelectionPayload();
    expect(selection).not.toBeNull();
    expect(selection?.selection?.start).toMatchObject({ line: 2, character: 1 });
    expect(selection?.selection?.end).toMatchObject({ line: 2, character: 6 });
    expect(selection?.text).toBe('line2');
  });
});
