import { describe, it, expect, vi } from 'vitest';
import { TERMINAL_VIEW_TYPE } from '../terminal/terminal-view';

vi.mock('xterm', () => ({
  Terminal: vi.fn().mockImplementation(() => ({
    open: vi.fn(),
    write: vi.fn(),
    onData: vi.fn(),
    onResize: vi.fn(),
    dispose: vi.fn()
  }))
}));

vi.mock('../terminal/pty', () => ({
  spawnPtyProcess: vi.fn(() => ({
    stdin: { write: vi.fn() },
    stdout: { on: vi.fn() },
    kill: vi.fn()
  }))
}));

describe('TerminalView', () => {
  it('registers terminal view type constant', () => {
    expect(TERMINAL_VIEW_TYPE).toBe('claude-ide-terminal');
  });
});
