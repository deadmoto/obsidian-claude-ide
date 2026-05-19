# Obsidian Claude IDE

Desktop-only Obsidian plugin that exposes the active markdown file and selection to Claude Code via MCP over a local WebSocket bridge.

## Scope (current)

- Desktop-only (`isDesktopOnly: true`)
- One active markdown file per vault
- Local-only MCP WebSocket bridge on `127.0.0.1`
- Required MCP tools:
  - `getCurrentFile`
  - `getWorkspaceFolders`
  - `openFile`
- Resource notifications for list updates and file updates

## Development

```bash
npm run install
npm run build
npm test
```

## Notes

- This plugin intentionally keeps the bridge read-only.
- PTY support is implemented through `src/terminal/pty-bridge.py` (embedded via `spawnPtyProcess`).

## Documentation

- [SPEC.md](./SPEC.md)
- [ARCHITECTURE.md](./ARCHITECTURE.md)
- [PROTOCOL.md](./PROTOCOL.md)
- [TERMINAL.md](./TERMINAL.md)
- [TESTING.md](./TESTING.md)

- Implementation complete in this commit.
