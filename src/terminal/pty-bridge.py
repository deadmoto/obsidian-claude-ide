#!/usr/bin/env python3
"""Simple PTY bridge helper for the Obsidian terminal view.

Keeps stdin/stdout/stderr/stdextra active and proxies data through a local shell
process. Kept intentionally minimal for plugin compatibility.
"""

import errno
import fcntl
import json
import os
import pty
import selectors
import signal
import struct
from struct import pack
from termios import TIOCSWINSZ
import sys


def _apply_winsize(pty_fd: int, rows: int, cols: int, child_pid: int | None = None) -> None:
    try:
        fcntl.ioctl(pty_fd, TIOCSWINSZ, pack('HHHH', rows, cols, 0, 0))
    except OSError:
        return

    if child_pid is None:
        return

    try:
        os.killpg(os.getpgid(child_pid), signal.SIGWINCH)
    except (OSError, ProcessLookupError):
        return


def _read_int(value: str | None):
    if not value:
        return None
    try:
        return int(value)
    except ValueError:
        return None


def main() -> int:
    shell = os.environ.get('SHELL', '/bin/bash')
    pid, fd = pty.fork()

    if pid == 0:
        os.execvp(shell, [shell])

    selector = selectors.DefaultSelector()
    sel_stdin = sys.stdin
    sel_stdout = os.fdopen(fd, 'rb', buffering=0)
    sel_sigchld = os.pipe()

    os.set_blocking(sel_sigchld[1], False)
    signal.set_wakeup_fd(sel_sigchld[1])
    signal.signal(signal.SIGCHLD, lambda *_: None)

    os.killpg(os.getpgid(pid), signal.SIGWINCH)

    for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(signum, lambda received, _frame: _forward_signal(received, pid))

    initial_cols = _read_int(os.environ.get('COLUMNS')) or 80
    initial_rows = _read_int(os.environ.get('LINES')) or 24
    _apply_winsize(fd, initial_rows, initial_cols, pid)

    selector.register(sel_stdin, selectors.EVENT_READ)
    selector.register(sel_stdout, selectors.EVENT_READ)
    selector.register(os.fdopen(sel_sigchld[0], 'rb', buffering=0), selectors.EVENT_READ)

    buffered_input = b''
    while True:
        for key, _ in selector.select():
            if key.fileobj is sel_sigchld[0]:
                try:
                    os.read(sel_sigchld[0], 8192)
                except OSError:
                    pass

                while True:
                    try:
                        finished_pid, status = os.waitpid(pid, os.WNOHANG)
                    except ChildProcessError:
                        return 0
                    except OSError:
                        break

                    if finished_pid != pid:
                        break
                    return os.waitstatus_to_exitcode(status)

            elif key.fileobj is sel_stdin:
                data = sel_stdin.buffer.read(8192) if hasattr(sel_stdin, 'buffer') else sel_stdin.read(8192)
                if not data:
                    continue

                buffered_input += data
                while b'\n' in buffered_input:
                    frame, remaining = buffered_input.split(b'\n', 1)
                    if frame.startswith(b'{') and frame.endswith(b'}'):
                        try:
                            payload = json.loads(frame.decode('utf-8'))
                        except (json.JSONDecodeError, UnicodeDecodeError):
                            payload = None

                        if payload and payload.get('type') == 'resize':
                            cols = payload.get('cols')
                            rows = payload.get('rows')
                            if isinstance(cols, int) and isinstance(rows, int):
                                _apply_winsize(fd, rows, cols, pid)
                            buffered_input = remaining
                            break
                    buffered_input = remaining
                    try:
                        os.write(fd, frame + b'\n')
                    except OSError:
                        pass

                if buffered_input and not buffered_input.startswith(b'{'):
                    try:
                        os.write(fd, buffered_input)
                    except OSError:
                        pass
                    buffered_input = b''

            elif key.fileobj is sel_stdout:
                chunk = sel_stdout.read(8192)
                if not chunk:
                    return 0
                sys.stdout.buffer.write(chunk)
                sys.stdout.buffer.flush()

    return 0


def _forward_signal(signal_number: int, child_pid: int) -> None:
    try:
        os.killpg(os.getpgid(child_pid), signal_number)
    except (OSError, ProcessLookupError):
        return


if __name__ == '__main__':
    raise SystemExit(main())
