# PROTOCOL: Obsidian Claude IDE

## 1. Discovery and Lock-File Contract

### 1.1 Lock directory
- Location: `~/.claude/ide` (`${os.homedir()}/.claude/ide`)

### 1.2 Lock file naming
- Filename: `<port>.lock` (JSON file).

### 1.3 Lock payload schema

```json
{
  "workspaceFolders": ["/absolute/path/to/vault"],
  "pid": 12345,
  "ideName": "Obsidian",
  "transport": "ws",
  "authToken": "<random hex token>"
}
```

### 1.4 Discovery flow
1. Plugin writes lock file after WebSocket bind succeeds.
2. Stale lock cleanup runs before writing.
3. Consumer discovers matching lock by scanning lock directory and matching `workspaceFolders`.
4. Consumer uses `pid/ideName/transport/authToken` pair from lock for validation and connection.

### 1.5 Stale lock cleanup
- A lock is stale when its `pid` is no longer alive.
- `deleteLockFile(port)` and stale sweep remove only obsolete entries (best effort).

## 2. Transport Contract (WebSocket)

### 2.1 Endpoint
- Host: `127.0.0.1`
- Port: dynamically discovered from lock file
- Transport: WebSocket

### 2.2 Authentication and protocol
- Header: `Sec-WebSocket-Protocol: mcp`
- Header: `x-claude-code-ide-authorization: <authToken>`
- If protocol or token mismatches, server closes with code `1008` and reason `Unauthorized`.

## 3. MCP Wire Format

### 3.1 Enveloped JSON-RPC
- Every message uses JSON-RPC 2.0.
- Request fields: `{ jsonrpc: "2.0", id, method, params? }`
- Successful response: `{ jsonrpc: "2.0", id, result }`
- Error response: `{ jsonrpc: "2.0", id, error: { code, message } }`
- Notifications omit `id`.

### 3.2 Handshake order
1. Client → `initialize` request
2. Server → `initialize` result (protocol/capabilities/server info)
3. Client → `tools/list`
4. Client → `resources/list`
5. Client → `notifications/initialized`
6. Client may call:
   - `tools/call`
   - `resources/read`
   - `resources/subscribe` / `resources/unsubscribe`

### 3.3 MCP Version/Capabilities
- `protocolVersion`: `2024-11-05`
- `serverInfo.name`: `obsidian-claude-ide`
- `serverInfo.version`: `0.1.0`
- capabilities: tools supported, resources with `subscribe: true`, `listChanged: true`

## 4. Tool and Resource Contracts

### 4.1 Tools
- `getCurrentFile`
  - method: `tools/call` with `name = getCurrentFile`
  - result: `{ content: [{ type: 'text', text: JSON.stringify(CurrentFilePayload) }] }`
- `getWorkspaceFolders`
  - result: `{ content: [{ type: 'text', text: JSON.stringify({ folders: [workspaceFolder] }) }] }`
- `openFile`
  - params: `{ name: 'openFile', arguments: { path?: string, uri?: string } }`
  - result: `{ content: [{ type: 'text', text: JSON.stringify(CurrentFilePayload) }] }`

### 4.2 Resource
- Resource URI form: `file://` + absolute path
- `resources/list` returns an array with at most one current file entry.
- `resources/read` supports only current active file URI match.

### 4.3 Notifications
- `selection_changed`
  - params: `SelectionPayload | null`
- `notifications/resources/list_changed`
  - params: `{ uris: string[] }`
- `notifications/resources/updated`
  - params: `{ uri: string }`
- On selection/resource list changes, adapter emits server-side notifications.

### 4.4 Error Cases
- Invalid JSON: `Invalid JSON`
- Invalid request shape: `Invalid MCP request`
- Missing arguments/path: method-specific errors (`Missing path argument`, `Resource uri missing`)
- Not found/unsupported: `Resource not found`, `Unsupported method`/tool

## 5. Data Types

### 5.1 SelectionPayload

```ts
interface SelectionPayload {
  filePath?: string;
  selection?: { start: { line: number; character: number }; end: { line: number; character: number } } | null;
  text?: string;
}
```

### 5.2 CurrentFilePayload

```ts
interface CurrentFilePayload {
  path: string;
  relativePath: string;
  language: string;
  content: string;
  isDirty: boolean;
  timestamp: string;
}
```
