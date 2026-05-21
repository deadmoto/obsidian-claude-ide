import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import WebSocket from 'ws';
import { EditorStateAdapter } from '../editor/state';
import { DEFAULT_SETTINGS } from '../settings';
import { WsAdapter } from '../bridge/ws-adapter';

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
    const editor = new EditorStateAdapter(mkApp() as any, { ...DEFAULT_SETTINGS, maxFileBytes: 4096 });
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

  it('answers resources/templates/list and prompts/list with empty arrays, errors on unknown methods', async () => {
    const port = await adapter.start();

    const ask = (id: number, method: string) =>
      new Promise<any>((resolve, reject) => {
        const s = new WebSocket(`ws://127.0.0.1:${port}`, 'mcp', {
          headers: { 'x-claude-code-ide-authorization': 'token-1' }
        });
        s.on('open', () => s.send(JSON.stringify({ jsonrpc: '2.0', id, method })));
        s.on('message', (msg) => {
          const parsed = JSON.parse(msg.toString());
          if (parsed.id === id) {
            resolve(parsed);
            s.close();
          }
        });
        s.on('error', reject);
      });

    const templates = await ask(10, 'resources/templates/list');
    expect(templates.error).toBeUndefined();
    expect(templates.result).toEqual({ resourceTemplates: [] });

    const prompts = await ask(11, 'prompts/list');
    expect(prompts.error).toBeUndefined();
    expect(prompts.result).toEqual({ prompts: [] });

    const bogus = await ask(12, 'frobnicate/foo');
    expect(bogus.result).toBeUndefined();
    expect(bogus.error).toBeDefined();
    expect(bogus.error.code).toBe(-32601);
    expect(bogus.error.message).toMatch(/Unsupported method/);
  });
});
