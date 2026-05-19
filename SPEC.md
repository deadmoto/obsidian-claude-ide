# SPEC: Obsidian Claude IDE

## 1. Scope and Platform Constraints

- The plugin is **desktop-only** (`isDesktopOnly: true`).
- One active Obsidian markdown context is surfaced at a time.
- The plugin speaks MCP to the local Claude Code client over WebSocket on `127.0.0.1`.
- Bridge ownership and handoff are represented via lock files in `~/.claude/ide`.
- MCP surface is intentionally read-focused for context and file-open operations.

## 2. Functional Requirements

### 2.1 Active Context Exposure
1. Expose the currently active markdown file:
   - absolute path (`path`)
   - vault-relative path (`relativePath`)
   - inferred `language`
   - file `content`
   - dirty state (`isDirty`)
   - snapshot timestamp
2. Expose selection payload when text is selected in the active file:
   - absolute `filePath`
   - selection span as 1-based line/character start/end
   - selected `text`
3. Prefer unsaved editor buffer when `shareUnsavedBuffer` is enabled.
4. Truncate file content at `maxFileBytes` (default `200000`) and annotate truncation prefix.

### 2.2 MCP Tool Surface
1. The adapter advertises and supports exactly these tools:
   - `getCurrentFile`
   - `getWorkspaceFolders`
   - `openFile`
2. The bridge supports MCP resources with:
   - list notifications
   - read notifications and responses for active file resource URI
   - resource subscriptions
3. On each resource/signaling event, server emits MCP notifications as defined by the implementation.

### 2.3 Bridge Lifecycle
1. Plugin startup may auto-start bridge based on setting `autoStartBridge`.
2. Plugin writes a lock file on bridge port and token before serving clients.
3. Plugin cleans up lock file and websocket server on bridge stop and app unload.

### 2.4 Operational Resilience
1. Stale lock files for dead process IDs are removed before new lock creation.
2. Unauthorized websocket headers/protocol combinations are rejected.
3. Bridge can run without a selected file and still handle protocol interactions.

## 3. Structural Constraints (post-PR #2)

- Source layout must reflect logical boundary:
  - `src/bridge/*`
  - `src/editor/*`
  - `src/terminal/*`
- Test structure should be co-located in `src/__tests__`.
- Test mocks should be in `src/__mocks__`.

## 4. Out of Scope

- Mobile support.
- Broad MCP write capabilities beyond current tool/resource surface.
- Full auto-launch orchestration for `claude` command (`autoLaunchClaudeWithIde` is currently not implemented).

## 5. Acceptance Criteria

- Plugin loads and unloads cleanly in desktop Obsidian.
- Active markdown context and selection are available via MCP.
- Client can subscribe/read active file resources and receive change notifications.
- Lock file schema and discovery flow are deterministic and testable.
- Unit tests in `src/__tests__` pass and align with source layout.

## 6. Glossary

- **MCP**: Model Context Protocol.
- **Lock file**: Local discovery artifact used by Claude Code to locate transport endpoint and token.
- **Resource**: MCP resource object (here, active file URI of current markdown note).
