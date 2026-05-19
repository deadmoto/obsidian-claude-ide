# TESTING: Obsidian Claude IDE

## Scope of coverage

- **Unit tests**: logic-level validation in `src/__tests__`
- **Integration-ish unit tests**: WS protocol and network behavior exercised through in-process `ws` clients
- **E2E placeholder**: Playwright stub retained for environment-dependent flows

## Test map

| Layer | Path | Purpose | Primary assertions |
|---|---|---|---|
| Unit | `src/__tests__/discovery.test.ts` | Discovery helpers | Lock creation, stale-lock cleanup, path filters, file deletion |
| Unit | `src/__tests__/bridge-net.test.ts` | Port helpers | Port availability checks and allocation range |
| Unit | `src/__tests__/editor-state.test.ts` | Editor state adapter | Current file payload, truncation, selection mapping |
| Unit/Integration | `src/__tests__/ws-adapter.test.ts` | MCP/WS adapter | Initialize, capabilities, tools list, and protocol-level connection lifecycle |
| Unit | `src/__tests__/terminal-view.test.ts` | Terminal view surface | Terminal type constant and integration points are wired |
| E2E | `tests/e2e/playwright-selection.spec.ts` | Selection-change behavior | Currently skipped (requires runtime harness not available in this environment) |

## Test seams and mocks

- `src/__mocks__/obsidian.ts` provides lightweight Obsidian API stubs for plugin/editor tests.
- `spawnPtyProcess` is mocked for terminal tests.
- `findFreePort`/`tryPort` are tested directly with real sockets.

## Current test commands

```bash
npm test             # vitest suite
npm run typecheck    # TypeScript compile gate
npm run build        # Plugin bundle build
```

## Recommended additions

1. **Protocol fixture tests**
   - assert full initialize handshake sequence and exact response shapes
2. **Selection notification tests**
   - mock editor state transitions and assert `selection_changed` payloads
3. **Path and URI compatibility tests**
   - ensure `file://` and absolute/relative path handling for `openFile` and `resources/read`
4. **Terminal contract tests**
   - when `python3` unavailable, verify graceful terminal fallback behavior
