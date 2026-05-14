import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import WebSocket from 'ws';
import { randomBytes } from 'node:crypto';
import { EditorStateAdapter } from '../../src/editor-state';
import { CLAUDE_IDE_DEFAULT_SETTINGS } from '../../src/settings';
import { WsAdapter } from '../../src/ws-adapter';

const mkApp = () => {
  const file = { path: 'notes/test.md', extension: 'md' };
  const markdownView: any = {
    file,
    editor: {
      getValue: () => '# title',
      getSelection: () => '',
      getCursor: () => ({ line: 0, ch: 0 })
    }
  };

  return {
    vault: {
      cachedRead: async () => '# title',
      getAbstractFileByPath: () => file,
      getRoot: () => ({ path: '/tmp/vault' })
    },
    workspace: {
      getActiveViewOfType: () => markdownView,
      getLeavesOfType: () => [{ view: markdownView }],
      getLeaf: () => ({ openFile: async () => undefined }),
      on: () => undefined,
      off: () => undefined
    }
  } as any;
};

describe('WsAdapter integration', () => {
  let adapter: WsAdapter;

  beforeEach(async () => {
    const editor = new EditorStateAdapter(mkApp() as any, { ...CLAUDE_IDE_DEFAULT_SETTINGS, maxFileBytes: 4096 });
    await editor.warmCache();
    adapter = new WsAdapter({ authToken: 'token-1', workspaceFolder: '/tmp/vault' }, editor, () => undefined);
  });

  afterEach(async () => {
    await adapter.stop();
  });

  it('negotiates initialize and advertises tools', async () => {
    const port = await adapter.start();
    const socket = new WebSocket(`ws://127.0.0.1:${port}`, 'mcp', {
      headers: {
        'x-claude-code-ide-authorization': 'token-1'
      }
    });

    const requestInit = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {}
    };

    const response = await new Promise<any>((resolve, reject) => {
      socket.on('open', () => {
        socket.send(JSON.stringify(requestInit));
      });

      socket.on('message', (msg) => {
        try {
          const parsed = JSON.parse(msg.toString());
          if (parsed.id === 1) {
            resolve(parsed);
          }
        } catch (error) {
          reject(error);
        }
      });

      socket.on('error', reject);
    });

    socket.close();

    expect(response.result).toHaveProperty('capabilities');
    const responseTools = await new Promise<any>((resolve) => {
      const s = new WebSocket(`ws://127.0.0.1:${port}`, 'mcp', {
        headers: {
          'x-claude-code-ide-authorization': 'token-1'
        }
      });

      s.on('open', () => {
        s.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));
      });

      s.on('message', (msg) => {
        const parsed = JSON.parse(msg.toString());
        if (parsed.id === 2) {
          resolve(parsed);
          s.close();
        }
      });
    });

    expect(responseTools.result.tools.map((tool: any) => tool.name)).toEqual(
      expect.arrayContaining(['getCurrentFile', 'getWorkspaceFolders', 'openFile'])
    );
  });
});
