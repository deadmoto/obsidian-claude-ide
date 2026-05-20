export const PTY_BRIDGE_SCRIPT = `#!/usr/bin/env python3
"""PTY bridge for the Obsidian Claude IDE terminal view.

Forks a child shell on a real pseudoterminal and proxies IO with the host.

Stdio contract (set by the Node.js caller):
    fd 0 (stdin)  → keystrokes forwarded to the PTY
    fd 1 (stdout) ← screen output forwarded from the PTY
    fd 2 (stderr) ← bridge script errors only
    fd 3 (cmdio)  ← resize control frames: "<rows>x<cols>\\\\n"

Environment:
    PTY_COLS / PTY_ROWS  initial xterm size (default 80x24)
    CLAUDE_IDE_CMD       optional command to run inside a login shell
                         (e.g. "claude"); if unset, a plain login+interactive
                         shell is launched.

Lifecycle: when the child exits, the PTY master returns EOF and this script
exits with the child's status. The Node side detaches the leaf on exit.
"""

from __future__ import annotations

import os
import signal
import sys
from fcntl import ioctl
from pty import fork
from selectors import EVENT_READ, DefaultSelector
from struct import pack
from termios import TIOCSWINSZ

_CHUNK = 4096
_STDIN = 0
_STDOUT = 1
_CMDIO = 3


def _write_all(fd: int, data: bytes) -> None:
    while data:
        try:
            n = os.write(fd, data)
        except OSError:
            return
        data = data[n:]


def _apply_winsize(pty_fd: int, rows: int, cols: int, child_pid: int | None = None) -> None:
    try:
        ioctl(pty_fd, TIOCSWINSZ, pack("HHHH", rows, cols, 0, 0))
    except OSError:
        return
    if child_pid is not None:
        try:
            os.killpg(os.getpgid(child_pid), signal.SIGWINCH)
        except (OSError, ProcessLookupError):
            pass


def main() -> int:
    shell = os.environ.get("SHELL", "/bin/zsh")
    startup_cmd = os.environ.get("CLAUDE_IDE_CMD", "").strip()
    pid, pty_fd = fork()

    if pid == 0:
        # Child: load login profile (PATH / pyenv / etc.) then run claude
        # (or drop into an interactive shell if no command was given).
        if startup_cmd:
            os.execvp(shell, [shell, "-l", "-c", startup_cmd])
        else:
            os.execvp(shell, [shell, "-l", "-i"])

    # Parent: initial winsize before the child starts drawing.
    try:
        cols = int(os.environ.get("PTY_COLS", "80"))
        rows = int(os.environ.get("PTY_ROWS", "24"))
    except ValueError:
        cols, rows = 80, 24
    _apply_winsize(pty_fd, rows, cols, pid)

    # Forward host signals to the child process group.
    def _forward(signum: int, _frame) -> None:
        try:
            os.killpg(os.getpgid(pid), signum)
        except (OSError, ProcessLookupError):
            pass

    for s in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(s, _forward)

    # fd 3 cmdio is optional — only register it if the parent actually piped it.
    cmdio_open = True
    try:
        os.fstat(_CMDIO)
    except OSError:
        cmdio_open = False

    selector = DefaultSelector()
    selector.register(_STDIN, EVENT_READ)
    selector.register(pty_fd, EVENT_READ)
    if cmdio_open:
        selector.register(_CMDIO, EVENT_READ)

    cmdio_buf = b""

    try:
        while True:
            for key, _ in selector.select(timeout=0.1):
                fd = key.fd

                if fd == _STDIN:
                    try:
                        data = os.read(_STDIN, _CHUNK)
                    except OSError:
                        data = b""
                    if not data:
                        try:
                            selector.unregister(_STDIN)
                        except KeyError:
                            pass
                        continue
                    _write_all(pty_fd, data)

                elif fd == pty_fd:
                    try:
                        data = os.read(pty_fd, _CHUNK)
                    except OSError:
                        data = b""
                    if not data:
                        # Child exited and closed the PTY master.
                        try:
                            _, status = os.waitpid(pid, 0)
                            return os.waitstatus_to_exitcode(status)
                        except (ChildProcessError, OSError):
                            return 0
                    _write_all(_STDOUT, data)

                elif fd == _CMDIO:
                    try:
                        data = os.read(_CMDIO, _CHUNK)
                    except OSError:
                        data = b""
                    if not data:
                        try:
                            selector.unregister(_CMDIO)
                        except KeyError:
                            pass
                        continue
                    cmdio_buf += data
                    while b"\\n" in cmdio_buf:
                        line, cmdio_buf = cmdio_buf.split(b"\\n", 1)
                        try:
                            r, c = line.decode("utf-8", "strict").strip().split("x", 1)
                            _apply_winsize(pty_fd, int(r), int(c), pid)
                        except (ValueError, UnicodeDecodeError):
                            pass

            # Reap child if it has exited but PTY hasn't EOF'd yet.
            try:
                finished, status = os.waitpid(pid, os.WNOHANG)
                if finished == pid:
                    return os.waitstatus_to_exitcode(status)
            except ChildProcessError:
                return 0
            except OSError:
                pass
    finally:
        try:
            selector.close()
        except Exception:
            pass


if __name__ == "__main__":
    raise SystemExit(main())
`;
