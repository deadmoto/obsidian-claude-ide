import { describe, it, expect, vi } from 'vitest';
import { TERMINAL_VIEW_TYPE } from '../terminal/terminal-view';

vi.mock('xterm', () => ({
  Terminal: vi.fn().mockImplementation(() => ({
    open: vi.fn(),
    write: vi.fn(),
    loadAddon: vi.fn(),
    onData: vi.fn(),
    onResize: vi.fn(),
    onTitleChange: vi.fn(),
    attachCustomKeyEventHandler: vi.fn(),
    paste: vi.fn(),
    getSelection: vi.fn(),
    clearSelection: vi.fn(),
    dispose: vi.fn()
  }))
}));

vi.mock('xterm-addon-fit', () => ({
  FitAddon: vi.fn().mockImplementation(() => ({
    fit: vi.fn(),
    dispose: vi.fn()
  }))
}));

vi.mock('../terminal/pty', () => ({
  spawnPtyProcess: vi.fn(() => ({
    stdin: { write: vi.fn() },
    stdout: { on: vi.fn() },
    onExit: vi.fn(),
    kill: vi.fn()
  }))
}));

describe('TerminalView', () => {
  it('registers terminal view type constant', () => {
    expect(TERMINAL_VIEW_TYPE).toBe('claude-ide-terminal');
  });
});
