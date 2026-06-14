#!/usr/bin/env python3
import fcntl
import os
import re
import selectors
import signal
import struct
import subprocess
import sys
import termios


# Sideband for test-driven resize: a chunk on stdin matching this pattern tells
# the driver to TIOCSWINSZ the PTY and signal SIGWINCH to the child, instead of
# forwarding the bytes. Terminal input never contains null bytes, so the
# sentinel cannot collide with real typing.
WINSZ_RE = re.compile(rb"^\x00PIXWINSZ:(\d+):(\d+)\x00$")


def resize_pty(pty_fd: int, child: subprocess.Popen, rows: int, cols: int) -> None:
    fcntl.ioctl(pty_fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    try:
        os.killpg(child.pid, signal.SIGWINCH)
    except ProcessLookupError:
        pass


def handle_stdin_chunk(data: bytes, master_fd: int, child: subprocess.Popen) -> bool:
    """Return True if the chunk was consumed as a control message (not forwarded)."""
    match = WINSZ_RE.match(data)
    if not match:
        return False
    rows = int(match.group(1))
    cols = int(match.group(2))
    resize_pty(master_fd, child, rows, cols)
    return True


def terminate_child(child: subprocess.Popen) -> int:
    if child.poll() is not None:
        return child.wait()

    try:
        os.killpg(child.pid, signal.SIGTERM)
    except ProcessLookupError:
        return child.wait()

    try:
        return child.wait(timeout=2)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        return child.wait(timeout=2)


def main() -> int:
    if len(sys.argv) < 4:
        print("usage: pty-driver.py <rows> <cols> <command> [args...]", file=sys.stderr)
        return 2

    rows = int(sys.argv[1])
    cols = int(sys.argv[2])
    command = sys.argv[3:]

    master_fd, slave_fd = os.openpty()
    fcntl.ioctl(slave_fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

    child = subprocess.Popen(
        command,
        stdin=slave_fd,
        stdout=slave_fd,
        stderr=slave_fd,
        close_fds=True,
        start_new_session=True,
    )
    os.close(slave_fd)

    selector = selectors.DefaultSelector()
    selector.register(master_fd, selectors.EVENT_READ)
    selector.register(sys.stdin.buffer, selectors.EVENT_READ)

    try:
        while child.poll() is None:
            for key, _ in selector.select(timeout=0.05):
                if key.fileobj == master_fd:
                    try:
                        data = os.read(master_fd, 8192)
                    except OSError:
                        return child.wait()
                    if not data:
                        return child.wait()
                    sys.stdout.buffer.write(data)
                    sys.stdout.buffer.flush()
                else:
                    data = sys.stdin.buffer.read1(8192)
                    if not data:
                        continue
                    if handle_stdin_chunk(data, master_fd, child):
                        continue
                    os.write(master_fd, data)
    finally:
        selector.close()
        try:
            os.close(master_fd)
        except OSError:
            pass

        terminate_child(child)

    return child.wait()


if __name__ == "__main__":
    raise SystemExit(main())
