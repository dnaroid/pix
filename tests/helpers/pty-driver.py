#!/usr/bin/env python3
import fcntl
import os
import selectors
import signal
import struct
import subprocess
import sys
import termios


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
                    os.write(master_fd, data)
    finally:
        selector.close()
        try:
            os.close(master_fd)
        except OSError:
            pass
        if child.poll() is None:
            try:
                os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass

    return child.wait()


if __name__ == "__main__":
    raise SystemExit(main())
