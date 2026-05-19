# TERMINAL: PTY Bridge Design

## Why not `node-pty`

This plugin intentionally avoids `node-pty` to reduce native-module pressure in Obsidian plugin builds and keep compatibility across environments that do not ship prebuilt `node-pty` binaries matching Obsidian's embedded Node runtime.

Instead, we use a tiny, embeddable Python PTY bridge (`src/terminal/pty-bridge.py`) executed by `python3` with four stdio pipes.

## 4-stdio-pipe contract

`spawnPtyProcess()` launches:

```ts
spawn('python3', [scriptPath, '--session-id', randomUUID()], {
  stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
  env: { ...process.env, PYTHONUNBUFFERED: '1' }
})
```

Pipe mapping:

- `stdio[0]` (`stdin`): terminal input from xterm to bridge
- `stdio[1]` (`stdout`): bridge output back to xterm
- `stdio[2]` (`stderr`): stderr forwarding
- `stdio[3]` (`extra`): reserved for future auxiliary stream (kept in API for compatibility)

`TerminalView` calls:
- `terminal.onData(...)` → writes to bridge stdin
- `terminal.onResize(...)` → writes JSON resize command to stdin (currently not consumed by bridge)
- bridge stdout chunks are written directly into xterm

## Bridge behavior (`src/terminal/pty-bridge.py`)

- Creates pseudo-terminal via `pty.fork()`.
- Child execs shell from `$SHELL` (fallback `/bin/bash`).
- Parent select-loop forwards bytes between stdin and PTY FD.
- Writes PTY output to stdout for terminal rendering.
- Watches child exit and returns child exit code.

## Script lookup

`TerminalView.getBridgePath()` checks:
1. Plugin-dev fallback path under plugin source tree
2. Legacy packaged location (`scripts/pty-bridge.py`) to remain backward-compatible
3. Falls back to temp script generation via `PTY_BRIDGE_SCRIPT` when absent

## Security and stability notes

- Script execution depends on `python3` availability.
- Bridge is started only when the integrated terminal view opens.
- Errors in cleanup/exit are tolerated by best effort (null-safe kill/unmount lifecycle in `onClose()`).
