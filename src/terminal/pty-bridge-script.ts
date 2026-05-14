export const PTY_BRIDGE_SCRIPT = `#!/usr/bin/env python3
"""Simple PTY bridge helper for the Obsidian terminal view.

Keeps stdin/stdout/stderr/stdextra active and proxies data through a local shell
process. Kept intentionally minimal for plugin compatibility.
"""

import os
import pty
import selectors
import signal
import subprocess
import sys


def main() -> int:
    shell = os.environ.get('SHELL', '/bin/bash')
    pid, fd = pty.fork()

    if pid == 0:
        # Child: connect stdin/stdout/stderr to PTY and exec shell.
        os.execvp(shell, [shell])

    selector = selectors.DefaultSelector()
    sel_stdin = sys.stdin
    sel_stdout = os.fdopen(fd, 'rb', buffering=0)
    child_proc = None

    selector.register(sel_stdin, selectors.EVENT_READ)
    selector.register(sel_stdout, selectors.EVENT_READ)

    while True:
        for key, _ in selector.select(timeout=0.1):
            if key.fileobj is sel_stdin:
                data = sel_stdin.buffer.read(8192) if hasattr(sel_stdin, 'buffer') else sel_stdin.read(8192)
                if not data:
                    continue
                try:
                    os.write(fd, data)
                except Exception:
                    pass
            elif key.fileobj is sel_stdout:
                chunk = sel_stdout.read(8192)
                if not chunk:
                    return 0
                sys.stdout.buffer.write(chunk)
                sys.stdout.buffer.flush()

        try:
            finished_pid, status = os.waitpid(pid, os.WNOHANG)
            if finished_pid == pid:
                return os.waitstatus_to_exitcode(status)
        except ChildProcessError:
            return 0
        except OSError:
            pass


if __name__ == '__main__':
    raise SystemExit(main())
`;