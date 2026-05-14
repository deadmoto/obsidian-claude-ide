import { WebSocket, WebSocketServer } from 'ws';
import { EditorStateAdapter } from './editor-state';
import { SelectionPayload } from './bridge/types';
import { findFreePort } from './bridge/net';
import path from 'node:path';

const MCP_PROTOCOL_VERSION = '2024-11-05';

type MessageId = string | number | null | undefined;

interface MCPRequest {
  jsonrpc: '2.0';
  id?: MessageId;
  method: string;
  params?: Record<string, unknown>;
}

interface MCPResponse {
  jsonrpc: '2.0';
  id?: MessageId;
  result?: unknown;
  error?: { code: number; message: string };
}

interface ToolDescription {
  name: string;
  description: string;
}

export interface BridgeConfig {
  authToken: string;
  workspaceFolder: string;
}

const TOOL_LIST: ToolDescription[] = [
  { name: 'getCurrentFile', description: 'Read the active markdown file snapshot.' },
  { name: 'getWorkspaceFolders', description: 'Return active workspace folders.' },
  { name: 'openFile', description: 'Open a file in Obsidian and return its snapshot.' }
];

export class WsAdapter {
  private server: WebSocketServer | null = null;
  private clients: Set<WebSocket> = new Set();
  private subscriptions: Set<string> = new Set();
  private started = false;
  private wsPort = 0;

  constructor(
    private readonly config: BridgeConfig,
    private readonly editorState: EditorStateAdapter,
    private readonly logger: (message: string) => void
  ) {}

  async start(): Promise<number> {
    if (this.started) {
      return this.wsPort;
    }

    const port = await findFreePort();
    const wsOptions = {
      port,
      host: '127.0.0.1',
      handleProtocols: (protocols: Set<string>) => {
        if (protocols.has('mcp')) {
          return 'mcp';
        }
        return false;
      }
    };

    return new Promise((resolve, reject) => {
      this.server = new WebSocketServer(wsOptions);

      this.server.on('listening', () => {
        const address = this.server?.address();
        if (typeof address === 'object' && address) {
          this.wsPort = address.port;
          this.started = true;
          this.logger(`bridge listening on 127.0.0.1:${this.wsPort}`);
          resolve(this.wsPort);
          return;
        }
        reject(new Error('Unable to determine ws port'));
      });

      this.server.on('connection', (socket, request) => this.onConnection(socket, request.headers));
      this.server.on('error', (error) => {
        this.logger(`bridge error: ${(error as Error).message}`);
        if (!this.started) {
          reject(error);
        }
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.close(1001, 'Server stopping');
      }
    }

    this.clients.clear();
    this.subscriptions.clear();

    await new Promise<void>((resolve) => {
      this.server?.close(() => {
        this.started = false;
        this.wsPort = 0;
        this.server = null;
        resolve();
      });
    });
  }

  get port(): number {
    return this.wsPort;
  }

  isStarted(): boolean {
    return this.started;
  }

  emitSelectionChanged(payload: SelectionPayload | null): void {
    this.broadcast({
      jsonrpc: '2.0',
      method: 'selection_changed',
      params: payload
    });
  }

  emitResourcesListChanged(): void {
    const current = this.editorState.getCurrentFilePath();
    const payload = {
      uris: current ? [`file://${this.config.workspaceFolder}/${current.replace(/^\//, '')}`] : []
    };
    this.broadcast({
      jsonrpc: '2.0',
      method: 'notifications/resources/list_changed',
      params: payload
    });
  }

  emitResourceUpdated(uri: string): void {
    if (!this.subscriptions.has(uri)) {
      return;
    }
    this.broadcast({
      jsonrpc: '2.0',
      method: 'notifications/resources/updated',
      params: { uri }
    });
  }

  private onConnection(socket: WebSocket, headers: Record<string, string | string[] | undefined>): void {
    const token = headers['x-claude-code-ide-authorization'];
    const protocols = headers['sec-websocket-protocol'];
    const protocol = typeof protocols === 'string' ? protocols.split(',').map((entry) => entry.trim()) : [];

    if (!protocol.includes('mcp') || token !== this.config.authToken) {
      socket.close(1008, 'Unauthorized');
      return;
    }

    this.clients.add(socket);
    socket.on('message', (payload) => this.onMessage(socket, payload.toString()));
    socket.on('close', () => this.clients.delete(socket));
    socket.on('error', () => this.clients.delete(socket));
  }

  private async onMessage(socket: WebSocket, payload: string): Promise<void> {
    let message: MCPRequest;
    try {
      message = JSON.parse(payload) as MCPRequest;
    } catch {
      this.sendError(socket, null, 'Invalid JSON');
      return;
    }

    if (!message || message.jsonrpc !== '2.0' || !message.method) {
      this.sendError(socket, message?.id, 'Invalid MCP request');
      return;
    }

    if (typeof message.id === 'undefined') {
      await this.handleNotification(socket, message);
      return;
    }

    switch (message.method) {
      case 'initialize':
        this.sendResponse(socket, message.id, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          serverInfo: {
            name: 'obsidian-claude-ide',
            version: '0.1.0'
          },
          capabilities: {
            tools: {},
            resources: {
              subscribe: true,
              listChanged: true
            }
          }
        });
        this.emitSelectionChanged(this.editorState.getSelectionPayload());
        break;
      case 'tools/list':
        this.sendResponse(socket, message.id, { tools: TOOL_LIST });
        this.emitSelectionChanged(this.editorState.getSelectionPayload());
        break;
      case 'resources/list':
        this.sendResponse(socket, message.id, { resources: this.listResources() });
        this.emitSelectionChanged(this.editorState.getSelectionPayload());
        break;
      case 'tools/call':
        await this.handleToolCall(socket, message);
        break;
      case 'resources/read':
        await this.handleResourceRead(socket, message);
        break;
      case 'resources/subscribe':
        this.handleSubscribe(socket, message, true);
        break;
      case 'resources/unsubscribe':
        this.handleSubscribe(socket, message, false);
        break;
      default:
        this.sendError(socket, message.id, `Unsupported method: ${message.method}`);
    }
  }

  private async handleNotification(socket: WebSocket, message: MCPRequest): Promise<void> {
    if (message.method === 'notifications/initialized') {
      this.emitSelectionChanged(this.editorState.getSelectionPayload());
      return;
    }
    this.sendTo(socket, { jsonrpc: '2.0', method: 'error', params: { message: `Unsupported notification: ${message.method}` } });
  }

  private async handleToolCall(socket: WebSocket, message: MCPRequest): Promise<void> {
    const method = (message.params?.name as string | undefined) ?? '';

    switch (method) {
      case 'getCurrentFile': {
        const file = this.editorState.getCurrentFile();
        if (!file) {
          this.sendError(socket, message.id, 'No active markdown file');
          return;
        }
        this.sendResponse(socket, message.id, {
          content: [
            {
              type: 'text',
              text: JSON.stringify(file)
            }
          ]
        });
        return;
      }
      case 'getWorkspaceFolders':
        this.sendResponse(socket, message.id, {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ folders: [this.config.workspaceFolder] })
            }
          ]
        });
        return;
      case 'openFile': {
        const args = (message.params?.arguments as Record<string, unknown> | undefined) || {};
        const pathArg = (args?.path as string | undefined) ?? (args?.uri as string | undefined);
        if (!pathArg) {
          this.sendError(socket, message.id, 'Missing path argument');
          return;
        }

        const opened = await this.editorState.openFile(pathArg);
        if (!opened) {
          this.sendError(socket, message.id, 'Unable to open file');
          return;
        }

        this.sendResponse(socket, message.id, {
          content: [
            {
              type: 'text',
              text: JSON.stringify(opened)
            }
          ]
        });
        return;
      }
      default:
        this.sendError(socket, message.id, `Unknown tool: ${method}`);
    }
  }

  private async handleResourceRead(socket: WebSocket, message: MCPRequest): Promise<void> {
    const uri = message.params?.uri as string | undefined;
    if (!uri || typeof uri !== 'string' || !uri.startsWith('file://')) {
      this.sendError(socket, message.id, 'Resource uri missing');
      return;
    }

    const file = this.editorState.getCurrentFile();
    if (!file || `file://${file.path}` !== uri) {
      this.sendError(socket, message.id, 'Resource not found');
      return;
    }

    this.sendResponse(socket, message.id, {
      contents: [
        {
          uri,
          mimeType: 'text/markdown',
          text: file.content
        }
      ]
    });
  }

  private handleSubscribe(socket: WebSocket, message: MCPRequest, subscribe: boolean): void {
    const uri = message.params?.uri as string | undefined;
    if (!uri || !uri.startsWith('file://')) {
      this.sendError(socket, message.id, 'Missing uri for subscription');
      return;
    }

    if (subscribe) {
      this.subscriptions.add(uri);
    } else {
      this.subscriptions.delete(uri);
    }

    this.sendResponse(socket, message.id, { subscribed: subscribe, uri });
  }

  private listResources(): Array<{ uri: string; name: string; mimeType: string; description: string }> {
    const file = this.editorState.getCurrentFile();
    if (!file) {
      return [];
    }
    const name = path.basename(file.relativePath);
    return [
      {
        uri: `file://${file.path}`,
        name,
        mimeType: file.language === 'markdown' ? 'text/markdown' : 'text/plain',
        description: file.relativePath
      }
    ];
  }

  private sendResponse(socket: WebSocket, id: MessageId, result: unknown): void {
    this.sendTo(socket, {
      jsonrpc: '2.0',
      id,
      result
    });
  }

  private sendError(socket: WebSocket, id: MessageId, message: string): void {
    this.sendTo(socket, {
      jsonrpc: '2.0',
      id,
      error: { code: -32600, message }
    });
  }

  private sendTo(socket: WebSocket, msg: MCPResponse | Record<string, unknown>): void {
    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }
    socket.send(JSON.stringify(msg));
  }

  private broadcast(msg: unknown): void {
    const serialized = JSON.stringify(msg);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(serialized);
      }
    }
  }
}
