// Deterministic regression harness for the owned-launch bridge stdio
// relay. The PRODUCTION bridge translation unit is compiled into this
// binary (below) and its real relay loop (bridge_relay) runs in a forked
// child over real UNIX sockets and pipes — no launchd, no launcher, no
// supervisor binary, no TCC. The harness parent plays the parent (Pi),
// the worker gate, and the supervisor.
//
// Modes (argv[1]):
//
//   backpressure-hup
//     The parent stalls the bridge's stdout pipe while the worker writes
//     256 KiB of distinguishable bytes (two 128 KiB phases + a final
//     JSONL line) and then closes its stream (poll sees HUP with unread
//     data while the 64 KiB relay queue still holds unflushed bytes).
//     After the stall is released the parent drains everything, delivers
//     the supervisor's worker_done verdict, and asserts:
//       - byte-for-byte equality with the exact generated stream,
//       - the final JSONL line arrives intact,
//       - the bridge exits with the verdict code (7).
//     This guards the invariant that a read source is never consumed
//     while its relay queue still holds unflushed bytes. On poll(2)
//     implementations that report POLLHUP regardless of events (Linux),
//     the pre-fix bridge overwrote the queued tail here; macOS currently
//     suppresses revents for events=0, so the same run proves the guard
//     without loss on either behavior.
//
//   stdin-hup
//     The worker closes its stdin connection first (the bridge stops
//     forwarding), then the parent closes the bridge's stdin pipe.
//     macOS poll(2) returns no revents for events=0 (verified by the
//     probe archived with this change), so the bridge must keep POLLIN
//     interest on fd 0 to observe the parent's EOF: the pre-fix bridge
//     masked fd 0 and hung forever. Assert exit 143 (parent-gone cancel)
//     within 5 s.
//
// Exit codes: 0 pass; 2 relay timeout; 3 payload mismatch; 4 wrong relay
// exit code; 5 setup failure.
#define main ol_bridge_main
#include "owned-launch-bridge.c"
#undef main

#define HARNESS_PHASE_BYTES (128u * 1024u)
#define HARNESS_TOTAL_BYTES (2u * HARNESS_PHASE_BYTES)
#define HARNESS_EXIT_OK 0
#define HARNESS_EXIT_TIMEOUT 2
#define HARNESS_EXIT_MISMATCH 3
#define HARNESS_EXIT_CODE 4
#define HARNESS_EXIT_SETUP 5

static const char *g_tail_line = "{\"type\":\"relay_done\",\"phase\":2,\"seq\":1}\n";
static int test_stderr = 0;

static void fill_pattern(unsigned char *dst, size_t n, uint32_t seed, int lower) {
  uint32_t s = seed;
  for (size_t i = 0; i < n; i++) {
    s ^= s << 13; s ^= s >> 17; s ^= s << 5;
    dst[i] = (unsigned char)((lower ? 'a' : 'A') + ((s >> 16) % 26));
  }
}

// The exact byte stream the worker produces (both phases + final line).
static size_t build_expected(unsigned char *dst, size_t cap) {
  size_t tail = strlen(g_tail_line);
  if (cap < HARNESS_TOTAL_BYTES + tail) return 0;
  fill_pattern(dst, HARNESS_PHASE_BYTES, 0x63534245u, 0);
  fill_pattern(dst + HARNESS_PHASE_BYTES, HARNESS_PHASE_BYTES, 0x12345678u, 1);
  memcpy(dst + HARNESS_TOTAL_BYTES, g_tail_line, tail);
  return HARNESS_TOTAL_BYTES + tail;
}

static int connect_sock(const char *name) {
  char path[OL_PATH_MAX];
  if ((size_t)snprintf(path, sizeof(path), "%s/%s", g_sock_dir, name) >= sizeof(path)) return -1;
  int fd = socket(AF_UNIX, SOCK_STREAM, 0);
  if (fd < 0) return -1;
  struct sockaddr_un addr;
  memset(&addr, 0, sizeof(addr));
  addr.sun_family = AF_UNIX;
  strncpy(addr.sun_path, path, sizeof(addr.sun_path) - 1);
  if (connect(fd, (struct sockaddr *)&addr, sizeof(addr))) { close(fd); return -1; }
  return fd;
}

static void write_all(int fd, const void *buf, size_t n) {
  const unsigned char *p = buf;
  while (n) {
    ssize_t k = write(fd, p, n);
    if (k < 0) { if (errno == EINTR) continue; _exit(HARNESS_EXIT_SETUP); }
    p += k; n -= (size_t)k;
  }
}

// Reap pid within `seconds`; 0 on normal exit (*code = status), 3 on timeout
// (child is SIGKILLed and reaped), 1 on signal death, 2 on waitpid error.
static int wait_exit(pid_t pid, long seconds, int *code) {
  struct timespec start, now;
  clock_gettime(CLOCK_MONOTONIC, &start);
  for (;;) {
    int st = 0;
    pid_t r = waitpid(pid, &st, WNOHANG);
    if (r == pid) {
      if (WIFEXITED(st)) { *code = WEXITSTATUS(st); return 0; }
      *code = WTERMSIG(st); return 1;
    }
    if (r < 0) { *code = errno; return 2; }
    clock_gettime(CLOCK_MONOTONIC, &now);
    if (now.tv_sec - start.tv_sec >= seconds) {
      kill(pid, SIGKILL);
      while (waitpid(pid, &st, 0) < 0 && errno == EINTR) {}
      *code = 0; return 3;
    }
    ol_sleep_ms(10);
  }
}

// Drain fd (nonblocking) into buf until `want` bytes arrive or the deadline
// passes. Returns bytes read, or -1 on deadline/error.
static ssize_t drain_exact(int fd, unsigned char *buf, size_t want, long seconds) {
  size_t got = 0;
  struct timespec start, now;
  clock_gettime(CLOCK_MONOTONIC, &start);
  while (got < want) {
    struct pollfd p = { .fd = fd, .events = POLLIN };
    clock_gettime(CLOCK_MONOTONIC, &now);
    long left_ms = seconds * 1000 - (now.tv_sec - start.tv_sec) * 1000 - (now.tv_nsec - start.tv_nsec) / 1000000;
    if (left_ms <= 0) return -1;
    int pr = poll(&p, 1, left_ms > 500 ? 500 : (int)left_ms);
    if (pr < 0 && errno != EINTR) return -1;
    if (pr == 0) continue;
    ssize_t k = read(fd, buf + got, want - got);
    if (k > 0) { got += (size_t)k; continue; }
    if (k == 0) return (ssize_t)got; // EOF early
    if (errno == EINTR || errno == EAGAIN) continue;
    return -1;
  }
  return (ssize_t)got;
}

// Common setup: 0700 socket dir, production listeners, parent stdio pipes,
// and the forked relay child running the production loop on fds 0/1/2.
// Returns the relay pid; fills the parent-side ends. -1 on setup failure.
static pid_t spawn_relay(int pin[2], int pout[2]) {
  char tmpl[] = "/tmp/ol-relay-harness-XXXXXX";
  if (!mkdtemp(tmpl)) return -1;
  strncpy(g_sock_dir, tmpl, sizeof(g_sock_dir) - 1);
  g_ctrl_listen = make_listener("control.sock");
  g_in_listen = make_listener("stdin.sock");
  g_out_listen = make_listener("stdout.sock");
  g_err_listen = make_listener("stderr.sock");
  if (g_ctrl_listen < 0 || g_in_listen < 0 || g_out_listen < 0 || g_err_listen < 0) return -1;
  if (pipe(pin) || pipe(pout)) return -1;
  int devnull = open("/dev/null", O_RDWR);
  if (devnull < 0) return -1;
  pid_t pid = fork();
  if (pid < 0) return -1;
  if (pid == 0) {
    close(pin[1]); close(pout[0]);
    if (dup2(pin[0], 0) < 0 || dup2(pout[1], test_stderr ? 2 : 1) < 0 ||
        dup2(devnull, test_stderr ? 1 : 2) < 0) _exit(HARNESS_EXIT_SETUP);
    close(pin[0]); close(pout[1]);
    if (devnull > 2) close(devnull);
    // Same dispositions the production main() installs before relaying.
    signal(SIGALRM, on_alarm);
    signal(SIGTERM, on_term);
    signal(SIGINT, on_term);
    signal(SIGPIPE, SIG_IGN);
    nonblocking(0); nonblocking(1); nonblocking(2);
    ol_spec_t spec;
    memset(&spec, 0, sizeof(spec));
    spec.release_timeout_seconds = 30;
    struct timespec t0;
    clock_gettime(CLOCK_MONOTONIC, &t0);
    bridge_relay(&spec, &t0); // never returns; exits via bridge_exit()
    _exit(HARNESS_EXIT_SETUP);
  }
  close(pin[0]); close(pout[1]); close(devnull);
  return pid;
}

static void close_listeners(void) {
  if (g_ctrl_listen >= 0) close(g_ctrl_listen);
  if (g_in_listen >= 0) close(g_in_listen);
  if (g_out_listen >= 0) close(g_out_listen);
  if (g_err_listen >= 0) close(g_err_listen);
  g_ctrl_listen = g_in_listen = g_out_listen = g_err_listen = -1;
}

static void cleanup_sock_dir(void) {
  cleanup_listeners(); // unlinks exactly the listeners make_listener bound
  rmdir(g_sock_dir);
}

static int mode_backpressure_hup(void) {
  static unsigned char expected[300000], got[300000];
  int pin[2], pout[2];
  pid_t relay = spawn_relay(pin, pout);
  if (relay < 0) { fprintf(stderr, "setup: spawn_relay failed\n"); return HARNESS_EXIT_SETUP; }
  int w_ctrl = connect_sock("control.sock");
  int w_in = connect_sock("stdin.sock");
  int w_out = connect_sock("stdout.sock");
  int w_err = connect_sock("stderr.sock");
  if (test_stderr) { int swap = w_out; w_out = w_err; w_err = swap; }
  close_listeners();
  size_t total = build_expected(expected, sizeof(expected));
  if (w_ctrl < 0 || w_in < 0 || w_out < 0 || w_err < 0 || !total) {
    fprintf(stderr, "setup: connect/expected failed\n");
    cleanup_sock_dir();
    return HARNESS_EXIT_SETUP;
  }
  close(w_in); // no worker stdin traffic in this mode
  shutdown(w_err, SHUT_WR); // worker stderr closes immediately

  // Worker: write the whole stream, then close (HUP with data possibly
  // still queued behind the stalled parent stdout).
  pid_t worker = fork();
  if (worker == 0) {
    close(pin[1]); close(pout[0]); close(w_ctrl); close(w_err);
    unsigned char chunk[16384];
    size_t off = 0;
    while (off < total) {
      size_t n = total - off > sizeof(chunk) ? sizeof(chunk) : total - off;
      memcpy(chunk, expected + off, n);
      write_all(w_out, chunk, n);
      off += n;
    }
    shutdown(w_out, SHUT_WR);
    close(w_out);
    _exit(0);
  }

  // Stall: the bridge fills its 64 KiB queue and blocks writing fd 1.
  ol_sleep_ms(400);

  // Release the stall and drain the exact expected bytes.
  ssize_t n = drain_exact(pout[0], got, total, 20);
  if (n != (ssize_t)total) {
    fprintf(stderr, "mismatch: drained %zd of %zu bytes\n", n, total);
    kill(relay, SIGKILL); kill(worker, SIGKILL);
    int st; waitpid(relay, &st, 0); waitpid(worker, &st, 0);
    cleanup_sock_dir();
    return HARNESS_EXIT_MISMATCH;
  }

  // Supervisor verdict: worker_done, code 7.
  const char *verdict = "{\"type\":\"worker_done\",\"cause\":\"exit\",\"code\":7,\"t\":0}\n";
  write_all(w_ctrl, verdict, strlen(verdict));

  int code = 0, wr = wait_exit(relay, 10, &code);
  if (wr != 0) {
    fprintf(stderr, "relay: timeout/abnormal wait=%d code=%d\n", wr, code);
    int st = 0;
    kill(worker, SIGKILL);
    while (waitpid(worker, &st, 0) < 0 && errno == EINTR) {}
    cleanup_sock_dir();
    return wr == 3 ? HARNESS_EXIT_TIMEOUT : HARNESS_EXIT_CODE;
  }
  if (code != 7) {
    fprintf(stderr, "relay: exit code %d, want 7\n", code);
    int st = 0;
    kill(worker, SIGKILL);
    while (waitpid(worker, &st, 0) < 0 && errno == EINTR) {}
    cleanup_sock_dir();
    return HARNESS_EXIT_CODE;
  }

  // After the relay's death nothing more may arrive on stdout.
  ssize_t extra = drain_exact(pout[0], got, 1, 2);
  int wcode = 0, wwr = wait_exit(worker, 10, &wcode);
  close(pout[0]); close(pin[1]); close(w_ctrl); close(w_err);
  cleanup_sock_dir();
  if (extra != 0) {
    fprintf(stderr, "mismatch: %zd trailing bytes after exit\n", extra);
    return HARNESS_EXIT_MISMATCH;
  }
  if (memcmp(got, expected, total) != 0) {
    for (size_t i = 0; i < total; i++) {
      if (got[i] != expected[i]) {
        fprintf(stderr, "mismatch: first diff at %zu (phase %zu): got '%c' want '%c'\n",
                i, i / HARNESS_PHASE_BYTES, got[i], expected[i]);
        break;
      }
    }
    return HARNESS_EXIT_MISMATCH;
  }
  size_t tail = strlen(g_tail_line);
  if (memcmp(got + total - tail, g_tail_line, tail) != 0) {
    fprintf(stderr, "mismatch: final JSONL line corrupted\n");
    return HARNESS_EXIT_MISMATCH;
  }
  if (wwr != 0 || wcode != 0) return HARNESS_EXIT_CODE;
  return HARNESS_EXIT_OK;
}

static int mode_stdin_hup(void) {
  int pin[2], pout[2];
  pid_t relay = spawn_relay(pin, pout);
  if (relay < 0) { fprintf(stderr, "setup: spawn_relay failed\n"); return HARNESS_EXIT_SETUP; }
  int w_ctrl = connect_sock("control.sock");
  int w_in = connect_sock("stdin.sock");
  int w_out = connect_sock("stdout.sock");
  int w_err = connect_sock("stderr.sock");
  close_listeners();
  if (w_ctrl < 0 || w_in < 0 || w_out < 0 || w_err < 0) {
    fprintf(stderr, "setup: connect failed\n");
    cleanup_sock_dir();
    return HARNESS_EXIT_SETUP;
  }
  shutdown(w_out, SHUT_WR);
  shutdown(w_err, SHUT_WR);
  // Worker closes its stdin connection; the bridge must notice on the
  // next forwarded write and stop forwarding.
  close(w_in);
  // Parent still sends RPC bytes (they are undeliverable now and must be
  // discarded, not fatal, not silently queued forever).
  write_all(pin[1], "ping\n", 5);
  ol_sleep_ms(400);
  // Parent (Pi) goes away without any stop() handshake.
  close(pin[1]);
  int code = 0, wr = wait_exit(relay, 5, &code);
  close(pout[0]); close(w_ctrl); close(w_out); close(w_err);
  cleanup_sock_dir();
  if (wr == 3) { fprintf(stderr, "relay: hung after parent stdin EOF\n"); return HARNESS_EXIT_TIMEOUT; }
  if (wr != 0) { fprintf(stderr, "relay: abnormal wait=%d code=%d\n", wr, code); return HARNESS_EXIT_CODE; }
  if (code != 143) { fprintf(stderr, "relay: exit code %d, want 143\n", code); return HARNESS_EXIT_CODE; }
  return HARNESS_EXIT_OK;
}

int main(int argc, char **argv) {
  if (argc != 2) return HARNESS_EXIT_SETUP;
  if (!strcmp(argv[1], "stderr-backpressure-hup")) {
    test_stderr = 1;
    return mode_backpressure_hup();
  }
  if (!strcmp(argv[1], "backpressure-hup")) return mode_backpressure_hup();
  if (!strcmp(argv[1], "stdin-hup")) return mode_stdin_hup();
  return HARNESS_EXIT_SETUP;
}
