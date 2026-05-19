# ARCHITECTURE: Obsidian Claude IDE

## Component Diagram

```mermaid
flowchart TB
  subgraph Obsidian Host
    App[Obsidian App]
    Vault[Vault + Active Markdown View]
    Editor[EditorStateAdapter]\n(app/vault/workspace wrappers)
    Plugin[ClaudeIdePlugin]
    Discovery[Discovery (lock file helpers)]
    Terminal[Terminal View / PTY Bridge]
    Bridge[WsAdapter]
    Net[Bridge Net Utils]
  end

  Client[Claude Code MCP Client]

  App --> Plugin
  Vault --> Editor
  Editor --> Plugin
  Plugin --> Editor
  Plugin --> Discovery
  Discovery -->|write/read/delete| FileStore[(~/.claude/ide/*.lock)]
  Plugin --> Net --> Bridge
  Plugin --> Bridge
  Plugin --> Terminal
  Bridge -->|ws://127.0.0.1:port + headers| Client
  Editor -->|selection/file snapshots| Bridge

  classDef boundary fill:#f4f4f4,stroke:#666;
  class ObsidianHost boundary
```

## Data/Control Flow

1. Plugin starts and optionally calls `startBridge()`.
2. `EditorStateAdapter` warms cache and enters polling loop (`250ms`).
3. `WsAdapter.start()` binds websocket on free local port and sets auth token.
4. Plugin writes lock payload with workspace + token for discovery.
5. External client reads matching lock, validates token, opens websocket with protocol `mcp`.
6. Client initializes MCP, requests tools/resources; server responds from editor snapshot.
7. File/selection changes in Obsidian trigger cached-state diffs and resource/selection notifications.

## Test-Seam Diagram

```mermaid
flowchart TD
  mainTS[main.ts]\n(Plugin lifecycle)
  discovery[bridge/discovery.ts]\n(file lock helpers)
  net[bridge/net.ts]\n(port allocator)
  ws[bridge/ws-adapter.ts]\n(MCP server logic)
  editor[editor/state.ts]\n(snapshot extraction)
  term[terminal/pty.ts]\n(PTY spawn + wrapper)
  settings[settings.ts]\n(defaults + settings UI)

  mainTS --> discovery
  mainTS --> net
  mainTS --> ws
  mainTS --> editor
  mainTS --> term
  mainTS --> settings

  %% unit test seams
  subgraph test seams
    testBridge[src/__tests__/bridge-net.test.ts] --> net
    testDiscovery[src/__tests__/discovery.test.ts] --> discovery
    testEditor[src/__tests__/editor-state.test.ts] --> editor
    testWs[src/__tests__/ws-adapter.test.ts] --> ws
    testTerm[src/__tests__/terminal-view.test.ts] --> term
    mockObsidian[src/__mocks__] --> editor
  end
```

## Structural Invariants

- `src/bridge/*` owns transport/discovery concerns.
- `src/editor/*` owns editor state/cache/selection extraction.
- `src/terminal/*` owns terminal + PTY orchestration.
- External dependencies (`obsidian`, `ws`, `xterm`) are contained behind adapters and mocks for tests.
