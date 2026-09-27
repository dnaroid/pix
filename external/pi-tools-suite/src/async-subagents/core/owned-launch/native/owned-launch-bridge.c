// owned-launch bridge — spawned detached by the TypeScript launcher as the
// process-group leader the parent (Pi) directly owns. It preserves the
// parent's stdio RPC interface: the parent keeps talking JSONL RPC over the
// bridge's stdin/stdout exactly as it would to a spawned pi process, and
// the parent's group-signal interface still works (the bridge leads its
// own group and has no same-group members; a group kill reaches only the
// bridge, whose death is the containment trigger, never the payload).
//
// Responsibilities:
//   - create the private 0600 UNIX sockets (control + stdin/stdout/stderr)
//     in a 0700 directory BEFORE anything else exists;
//   - bootstrap the per-run UUID launchd supervisor job (KeepAlive) into
//     gui/<uid> so it is owned by launchd, not by this lineage — it must
//     survive simultaneous Pi/bridge/worker loss;
//   - relay stdio between the parent and the worker gate's socket
//     connections (prompt bytes buffered until the gate connects; the gate
//     itself never reads them, so nothing is lost across the release park);
//   - apply the supervisor's verdicts: worker_done (exit 0), cancelled
//     (exit 143), fatal (exit 125);
//   - fail closed on every startup failure with bounded watchdogs, and
//     never release work itself (only the supervisor's release marker can).
//
// The bridge never signals any process and never bootstraps the worker job;
// it cannot be the source of a bootstrap race. Bridge death is the
// containment trigger at ANY point: pre-release the supervisor's liveness
// check usually cancels before anything is released, but the check→release
// window is genuinely non-atomic — if release wins that race the payload
// is released posthumously (it may briefly run) and the supervisor still
// drains it to a kernel-zero receipt on control EOF (staged
// deterministically by the pre-release barrier test).
#include <poll.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/wait.h>

#include "owned-launch-common.h"

#define OL_BRIDGE_EXIT_OK 0
#define OL_BRIDGE_EXIT_FATAL 125
#define OL_BRIDGE_EXIT_CANCELLED 143
#define OL_BRIDGE_STDIN_BUFFER_MAX (8u * 1024u * 1024u)

static const char *g_dir;
static char g_sock_dir[OL_PATH_MAX];
static int g_ctrl_listen = -1, g_in_listen = -1, g_out_listen = -1, g_err_listen = -1;
static int g_ctrl = -1, g_in = -1, g_out = -1, g_err = -1;
static volatile sig_atomic_t g_alarm = 0, g_term = 0;
static int g_released = 0;
static int g_exit_pending = -1;
static int g_worker_done = 0;
static unsigned g_watchdog = 3600;
static int g_stdin_stopped = 0; // worker closed stdin: stop forwarding (later parent bytes are discarded), keep relaying
static char *g_in_buf = NULL;
static size_t g_in_len = 0, g_in_cap = 0;
static char g_ctrl_line[4096];
static size_t g_ctrl_used = 0;
typedef struct { char data[65536]; size_t used; } relay_queue;
static relay_queue g_stdout_q, g_stderr_q;
static void nonblocking(int fd) { int flags = fcntl(fd, F_GETFL); if (flags >= 0) (void)fcntl(fd, F_SETFL, flags | O_NONBLOCK); }
static int flush_queue(int fd, relay_queue *q) {
  if (!q->used) return 0;
  ssize_t n = write(fd, q->data, q->used);
  if (n > 0) { memmove(q->data, q->data + n, q->used - (size_t)n); q->used -= (size_t)n; return 0; }
  return n < 0 && (errno == EAGAIN || errno == EINTR) ? 0 : -1;
}

static void on_alarm(int sig) { (void)sig; g_alarm = 1; }
static void on_term(int sig) { (void)sig; g_term = 1; }

// Listener paths this process actually bound. Exit cleanup unlinks only
// these: an entry some other writer created (corruption, a stale path) is
// never removed on its behalf.
static const char *g_bound[4];
static int g_bound_count;

static void cleanup_listeners(void) {
  for (int i = 0; i < g_bound_count; i++) {
    char path[OL_PATH_MAX];
    if ((size_t)snprintf(path, sizeof(path), "%s/%s", g_sock_dir, g_bound[i]) < sizeof(path)) (void)unlink(path);
  }
}

static _Noreturn void bridge_exit(int code) {
  cleanup_listeners();
  _exit(code);
}

static int make_listener(const char *name) {
  char path[OL_PATH_MAX];
  if ((size_t)snprintf(path, sizeof(path), "%s/%s", g_sock_dir, name) >= sizeof(path)) return -1;
  int fd = socket(AF_UNIX, SOCK_STREAM, 0);
  if (fd < 0) return -1;
  struct sockaddr_un addr;
  memset(&addr, 0, sizeof(addr));
  addr.sun_family = AF_UNIX;
  if (strlen(path) >= sizeof(addr.sun_path)) { close(fd); return -1; }
  strncpy(addr.sun_path, path, sizeof(addr.sun_path) - 1);
  // Never unlink: a fresh 0700 UUID directory must not contain stale
  // entries; EADDRINUSE means corruption and fails closed.
  if (bind(fd, (struct sockaddr *)&addr, sizeof(addr))) {
    close(fd);
    return -1;
  }
  g_bound[g_bound_count++] = name;
  if (listen(fd, 8) || chmod(path, 0600)) {
    close(fd);
    return -1;
  }
  return fd;
}

static int run_launchctl(const char *const argv[]) {
  pid_t pid = fork();
  if (pid < 0) return -1;
  if (pid == 0) {
    // stdout belongs exclusively to payload JSONL; launchctl diagnostics
    // must never enter that protocol or consume queued RPC input.
    int input = open("/dev/null", O_RDONLY);
    if (input < 0 || dup2(input, STDIN_FILENO) < 0 ||
        dup2(STDERR_FILENO, STDOUT_FILENO) < 0) _exit(127);
    if (input > STDERR_FILENO) close(input);
    const char *env[] = { "PATH=/usr/bin:/bin:/usr/sbin:/sbin", NULL };
    execve("/bin/launchctl", (char *const *)argv, (char *const *)env);
    _exit(127);
  }
  int status = 0;
  if (waitpid(pid, &status, 0) != pid) return -1;
  return WIFEXITED(status) ? WEXITSTATUS(status) : -1;
}

static void xml_escape(const char *in, char *out, size_t out_sz) {
  size_t o = 0;
  for (const char *p = in; *p && o + 8 < out_sz; p++) {
    if (*p == '&') { memcpy(out + o, "&amp;", 5); o += 5; }
    else if (*p == '<') { memcpy(out + o, "&lt;", 4); o += 4; }
    else if (*p == '>') { memcpy(out + o, "&gt;", 4); o += 4; }
    else if (*p == '"') { memcpy(out + o, "&quot;", 6); o += 6; }
    else out[o++] = *p;
  }
  out[o] = '\0';
}

static int write_supervisor_plist(const ol_spec_t *spec) {
  char path[OL_PATH_MAX], xl[256], xb[OL_PATH_MAX], xd[OL_PATH_MAX];
  char buf[2 * OL_PATH_MAX];
  if ((size_t)snprintf(path, sizeof(path), "%s/job-supervisor.plist", g_dir) >= sizeof(path)) return -1;
  xml_escape(spec->label_supervisor, xl, sizeof(xl));
  xml_escape(spec->supervisor_binary, xb, sizeof(xb));
  xml_escape(g_dir, xd, sizeof(xd));
  int n = snprintf(buf, sizeof(buf),
      "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"
      "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n"
      "<plist version=\"1.0\"><dict><key>Label</key><string>%s</string>"
      "<key>ProgramArguments</key><array><string>%s</string><string>%s</string></array>"
      "<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>"
      "<key>StandardOutPath</key><string>%s/sup.out</string>"
      "<key>StandardErrorPath</key><string>%s/sup.err</string></dict></plist>\n",
      xl, xb, xd, xd, xd);
  if (n <= 0 || (size_t)n >= sizeof(buf)) return -1;
  return ol_write_atomic(path, buf, (size_t)n, 0600, 1);
}

// Apply one control line from the supervisor. Returns an exit code when the
// verdict is terminal, or -1 to continue.
static int apply_ctrl_line(const char *line, size_t len) {
  if (len == 0) return -1;
  if (strstr(line, "\"type\":\"worker_released\"")) {
    g_released = 1;
    alarm(g_watchdog); // bounded even if pipes stall
    return -1;
  }
  if (strstr(line, "\"type\":\"worker_done\"")) {
    int code = -1;
    if (sscanf(line, "{\"type\":\"worker_done\",\"cause\":\"%*[^\"]\",\"code\":%d,", &code) != 1 || code < 0 || code > 255) return OL_BRIDGE_EXIT_FATAL;
    g_worker_done = 1;
    return code;
  }
  if (strstr(line, "\"type\":\"cancelled\"")) return OL_BRIDGE_EXIT_CANCELLED;
  if (strstr(line, "\"type\":\"fatal\"")) return OL_BRIDGE_EXIT_FATAL;
  if (strstr(line, "\"type\":\"supervisor_hello\"")) return -1;
  return -1; // unknown lines never decide lifecycle
}

static int feed_ctrl(const char *data, size_t n) {
  for (size_t i = 0; i < n; i++) {
    if (data[i] == '\n') {
      g_ctrl_line[g_ctrl_used] = '\0';
      int rc = apply_ctrl_line(g_ctrl_line, g_ctrl_used);
      g_ctrl_used = 0;
      if (rc >= 0) return rc;
      continue;
    }
    if (g_ctrl_used + 1 >= sizeof(g_ctrl_line)) { g_ctrl_used = 0; return OL_BRIDGE_EXIT_FATAL; }
    g_ctrl_line[g_ctrl_used++] = data[i];
  }
  return -1;
}

static int buffer_stdin(const char *data, size_t n) {
  if (g_in_len + n > OL_BRIDGE_STDIN_BUFFER_MAX) return -1; // bounded: drop is fatal, never silent
  if (g_in_len + n > g_in_cap) {
    size_t cap = g_in_cap ? g_in_cap * 2 : 65536;
    while (cap < g_in_len + n) cap *= 2;
    char *nb = realloc(g_in_buf, cap);
    if (!nb) return -1;
    g_in_buf = nb;
    g_in_cap = cap;
  }
  memcpy(g_in_buf + g_in_len, data, n);
  g_in_len += n;
  return 0;
}

static int flush_stdin_to_worker(void) {
  if (!g_in_len || g_in < 0) return 0;
  ssize_t k = write(g_in, g_in_buf, g_in_len);
  if (k < 0 && (errno == EAGAIN || errno == EINTR)) return 0;
  if (k <= 0) return -1;
  memmove(g_in_buf, g_in_buf + k, g_in_len - (size_t)k);
  g_in_len -= (size_t)k;
  return 0;
}

static void stop_worker_stdin(void) {
  g_stdin_stopped = 1;
  g_in_len = 0;
  if (g_in >= 0) { close(g_in); g_in = -1; }
}

static int check_dir_security(const char *dir) {
  struct stat st;
  if (lstat(dir, &st) || !S_ISDIR(st.st_mode)) return -1;
  if ((st.st_mode & 0777) != 0700) return -1;
  if (st.st_uid != geteuid()) return -1;
  return 0;
}

// Exclusive launch claim (restart fencing). The complete record is written
// to a private temp file first and published with link(2), which fails with
// EEXIST when `claim` already exists: exactly one of this bridge and parent
// restart recovery (which links a `role=fence` record) can ever own the
// run, and the loser's claim never appears partially written. The claim
// precedes every listener bind and every launchctl action, so a fenced
// bridge exits before anything could be bootstrapped or released. 0 won,
// 1 fenced (EEXIST), 2 won but the directory fsync failed, -1 error before
// publication (fail closed, nothing started).
static int claim_run(const char *dir) {
  char tmp[OL_PATH_MAX], claim[OL_PATH_MAX], buf[128];
  if ((size_t)snprintf(tmp, sizeof(tmp), "%s/.claim.bridge.%d", dir, getpid()) >= sizeof(tmp) ||
      (size_t)snprintf(claim, sizeof(claim), "%s/claim", dir) >= sizeof(claim)) return -1;
  int n = snprintf(buf, sizeof(buf), "role=bridge-claim pid=%d\n", getpid());
  if (n <= 0 || (size_t)n >= sizeof(buf)) return -1;
  (void)unlink(tmp);
  int fd = open(tmp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (fd < 0) return -1;
  size_t off = 0;
  while (off < (size_t)n) {
    ssize_t k = write(fd, buf + off, (size_t)n - off);
    if (k <= 0) { close(fd); unlink(tmp); return -1; }
    off += (size_t)k;
  }
  if (fsync(fd) || close(fd)) { unlink(tmp); return -1; }
  int linked = link(tmp, claim);
  int saved = errno;
  (void)unlink(tmp);
  if (linked) return saved == EEXIST ? 1 : -1;
  int dfd = open(dir, O_RDONLY | O_DIRECTORY);
  if (dfd < 0) return 2;
  int synced = fsync(dfd);
  int closed = close(dfd);
  return synced || closed ? 2 : 0;
}

// Deterministic failure after winning the claim but before ANY launchctl
// action: durably record that this claimed run started nothing, so restart
// recovery can classify it never-launched instead of pending forever. If the
// record cannot be written the run stays pending (fail closed).
static _Noreturn void abort_prelaunch(int code) {
  char path[OL_PATH_MAX], buf[64];
  int n = snprintf(buf, sizeof(buf), "role=prelaunch-abort code=%d\n", code);
  if ((size_t)snprintf(path, sizeof(path), "%s/prelaunch_abort", g_dir) < sizeof(path) && n > 0 && (size_t)n < sizeof(buf))
    (void)ol_write_atomic(path, buf, (size_t)n, 0600, 1);
  bridge_exit(code);
}

static int bridge_poll_once(const ol_spec_t *spec, const struct timespec *t_start);
static void bridge_relay(const ol_spec_t *spec, const struct timespec *t_start);

int main(int argc, char **argv) {
  umask(077);
  setvbuf(stdout, NULL, _IONBF, 0);
  if (argc != 2) bridge_exit(10);
  g_dir = argv[1];
  ol_spec_t spec;
  if (ol_load_spec(g_dir, &spec)) bridge_exit(11);
  g_watchdog = (unsigned)(spec.watchdog_seconds + spec.drain_deadline_seconds + 60);
  if (check_dir_security(g_dir) || check_dir_security(spec.sockets_dir)) bridge_exit(12);
  strncpy(g_sock_dir, spec.sockets_dir, sizeof(g_sock_dir) - 1);
  // Fenced by restart recovery (17) or unclaimable (18): nothing bound,
  // nothing bootstrapped, nothing released.
  int claimed = claim_run(g_dir);
  if (claimed == 1) bridge_exit(17);
  if (claimed == 2) abort_prelaunch(18);
  if (claimed != 0) bridge_exit(18);

  signal(SIGALRM, on_alarm);
  signal(SIGTERM, on_term);
  signal(SIGINT, on_term);
  signal(SIGPIPE, SIG_IGN);
  nonblocking(0); nonblocking(1); nonblocking(2);

  // Publish our own identity for diagnostics only; nobody probes it.
  audit_token_t token;
  if (ol_self_token(&token) == 0) {
    char path[OL_PATH_MAX], buf[512];
    if ((size_t)snprintf(path, sizeof(path), "%s/bridge.json", g_dir) < sizeof(path)) {
      int n = snprintf(buf, sizeof(buf), "role=bridge pid=%d pidversion=%d start=%ld\n",
                       getpid(), audit_token_to_pidversion(token), ol_now_sec());
      if (n > 0 && (size_t)n < sizeof(buf)) (void)ol_write_atomic(path, buf, (size_t)n, 0600, 1);
    }
  }

  g_ctrl_listen = make_listener("control.sock");
  g_in_listen = make_listener("stdin.sock");
  g_out_listen = make_listener("stdout.sock");
  g_err_listen = make_listener("stderr.sock");
  if (g_ctrl_listen < 0 || g_in_listen < 0 || g_out_listen < 0 || g_err_listen < 0) abort_prelaunch(13);

  // Bootstrap the launchd-owned supervisor. It survives this process.
  if (write_supervisor_plist(&spec)) abort_prelaunch(14);
  char service[256];
  (void)snprintf(service, sizeof(service), "gui/%d/%s", getuid(), spec.label_supervisor);
  char domain[64];
  (void)snprintf(domain, sizeof(domain), "gui/%d", getuid());
  char plist_path[OL_PATH_MAX];
  (void)snprintf(plist_path, sizeof(plist_path), "%s/job-supervisor.plist", g_dir);
  const char *bargv[] = { "launchctl", "bootstrap", domain, plist_path, NULL };
  if (run_launchctl(bargv) != 0) {
    // Already-bootstrapped for a fresh UUID label means corruption; fail
    // closed either way (no supervisor, no worker, nothing released).
    bridge_exit(15);
  }
  // Bounded wait for the service to be visible (startup watchdog below
  // bounds the rest). The supervisor connects to control.sock itself.
  int registered = 0;
  for (int i = 0; i < 100; i++) {
    const char *pargv[] = { "launchctl", "print", service, NULL };
    if (run_launchctl(pargv) == 0) { registered = 1; break; }
    ol_sleep_ms(100);
  }
  if (!registered) {
    // The service may exist despite a failed print: supervisor owns the
    // journal and must remain installed until it can confirm a drain.
    bridge_exit(16);
  }

  // Root startup watchdog: if the supervisor never durably owns and
  // releases work in time, die (which the supervisor sees as control EOF
  // and cancels) rather than hanging the parent forever.
  alarm(90);

  struct timespec t_start;
  clock_gettime(CLOCK_MONOTONIC, &t_start);
  bridge_relay(&spec, &t_start);
  bridge_exit(OL_BRIDGE_EXIT_FATAL); // unreachable: bridge_relay never returns
}

// One iteration of the stdio relay. Returns an exit code when the bridge
// must terminate now, or -1 to continue relaying. Extracted verbatim from
// main() (behavior unchanged) so the deterministic harness under
// test/async-subagents/owned-launch can drive the production poll/queue
// paths over real sockets and pipes without launchd or the launcher.
static int bridge_poll_once(const ol_spec_t *spec, const struct timespec *t_start) {
    if (g_term) return OL_BRIDGE_EXIT_CANCELLED;
    if (g_alarm) return OL_BRIDGE_EXIT_FATAL;

    struct pollfd fds[11];
    int nfds = 0;
    // fd 0 keeps read interest even after the worker closed stdin:
    // poll(2) is not required to report POLLHUP unless it was requested
    // (macOS returns no revents at all for events=0, which hid the
    // parent's shutdown entirely), so masking fd 0 would make the
    // parent's control-EOF cancellation invisible. Bytes arriving after
    // forwarding stopped have no consumer and are discarded in the
    // handler below; the buffer-bound mask still applies for backpressure.
    short stdin_events = g_in_len >= OL_BRIDGE_STDIN_BUFFER_MAX - 65536 ? 0 : POLLIN;
    fds[nfds].fd = 0; fds[nfds].events = stdin_events; nfds++;
    int idx_in_listen = -1, idx_out_listen = -1, idx_err_listen = -1, idx_ctrl_listen = -1;
    int idx_ctrl = -1, idx_out = -1, idx_err = -1, idx_in = -1, idx_stdout = -1, idx_stderr = -1;
    if (g_ctrl_listen >= 0) { idx_ctrl_listen = nfds; fds[nfds].fd = g_ctrl_listen; fds[nfds].events = POLLIN; nfds++; }
    if (g_in_listen >= 0) { idx_in_listen = nfds; fds[nfds].fd = g_in_listen; fds[nfds].events = POLLIN; nfds++; }
    if (g_out_listen >= 0) { idx_out_listen = nfds; fds[nfds].fd = g_out_listen; fds[nfds].events = POLLIN; nfds++; }
    if (g_err_listen >= 0) { idx_err_listen = nfds; fds[nfds].fd = g_err_listen; fds[nfds].events = POLLIN; nfds++; }
    if (g_ctrl >= 0) { idx_ctrl = nfds; fds[nfds].fd = g_ctrl; fds[nfds].events = POLLIN; nfds++; }
    if (g_out >= 0 && !g_stdout_q.used) { idx_out = nfds; fds[nfds].fd = g_out; fds[nfds].events = POLLIN; nfds++; }
    if (g_err >= 0 && !g_stderr_q.used) { idx_err = nfds; fds[nfds].fd = g_err; fds[nfds].events = POLLIN; nfds++; }
    if (g_in >= 0 && g_in_len) { idx_in = nfds; fds[nfds].fd = g_in; fds[nfds].events = POLLOUT; nfds++; }
    if (g_stdout_q.used) { idx_stdout = nfds; fds[nfds].fd = 1; fds[nfds].events = POLLOUT; nfds++; }
    if (g_stderr_q.used) { idx_stderr = nfds; fds[nfds].fd = 2; fds[nfds].events = POLLOUT; nfds++; }

    int pr = poll(fds, (nfds_t)nfds, 100);
    if (pr < 0 && errno != EINTR) return OL_BRIDGE_EXIT_FATAL;
    if (pr <= 0) {
      // Idle: if the supervisor is gone post-release for a long window and
      // the payload streams are closed too, stop relaying (launchd would
      // restart the supervisor, which cancels; do not hang forever).
      return -1;
    }

    if (fds[0].revents & (POLLIN | POLLHUP)) {
      char buf[65536];
      ssize_t k = read(0, buf, sizeof(buf));
      if (k == 0) return OL_BRIDGE_EXIT_CANCELLED; // parent (Pi) is gone
      if (k < 0 && errno != EINTR) return OL_BRIDGE_EXIT_CANCELLED;
      if (k > 0 && !g_stdin_stopped) { // stopped: no consumer will ever take these bytes
        if (g_in >= 0) {
          if (buffer_stdin(buf, (size_t)k)) return OL_BRIDGE_EXIT_FATAL;
          if (flush_stdin_to_worker()) {
            // Worker closed stdin or buffer bound: stop forwarding, keep
            // relaying output and waiting for the verdict.
            stop_worker_stdin();
          }
        } else if (buffer_stdin(buf, (size_t)k)) {
          return OL_BRIDGE_EXIT_FATAL;
        }
      }
    }
    if (idx_ctrl_listen >= 0 && (fds[idx_ctrl_listen].revents & POLLIN)) {
      int c = accept(g_ctrl_listen, NULL, NULL);
      if (c >= 0) {
        nonblocking(c);
        if (g_ctrl >= 0) close(g_ctrl); // supervisor restart reconnects
        g_ctrl = c;
      }
    }
    if (idx_in_listen >= 0 && (fds[idx_in_listen].revents & POLLIN)) {
      int c = accept(g_in_listen, NULL, NULL);
      if (c >= 0) {
        nonblocking(c);
        g_in = c;
        close(g_in_listen); g_in_listen = -1;
        if (flush_stdin_to_worker()) stop_worker_stdin();
      }
    }
    if (idx_out_listen >= 0 && (fds[idx_out_listen].revents & POLLIN)) {
      int c = accept(g_out_listen, NULL, NULL);
      if (c >= 0) { nonblocking(c); g_out = c; close(g_out_listen); g_out_listen = -1; }
    }
    if (idx_err_listen >= 0 && (fds[idx_err_listen].revents & POLLIN)) {
      int c = accept(g_err_listen, NULL, NULL);
      if (c >= 0) { nonblocking(c); g_err = c; close(g_err_listen); g_err_listen = -1; }
    }
    if (idx_ctrl >= 0 && (fds[idx_ctrl].revents & (POLLIN | POLLHUP | POLLERR))) {
      char buf[4096];
      ssize_t k = read(g_ctrl, buf, sizeof(buf));
      if (k <= 0) {
        // Supervisor connection dropped. Pre-release this may be a
        // supervisor crash (launchd KeepAlive restarts it and it reconnects
        // or recovers from the journal); post-release a restarted
        // supervisor cancels via the journal. Wait for a reconnect bounded
        // by the startup watchdog / overall patience below.
        close(g_ctrl); g_ctrl = -1;
        if (!g_released) {
          struct timespec now;
          clock_gettime(CLOCK_MONOTONIC, &now);
          if (now.tv_sec - t_start->tv_sec > spec->release_timeout_seconds + 30)
            return OL_BRIDGE_EXIT_FATAL;
        }
      } else {
        int rc = feed_ctrl(buf, (size_t)k);
        if (rc >= 0) {
          if (g_worker_done) g_exit_pending = rc;
          else return rc;
        }
      }
    }
    // Never read from a relay source whose queue still holds unflushed
    // bytes: the read would overwrite them. Omitting the source from poll
    // also prevents a persistent POLLHUP from spinning under backpressure.
    // EOF remains observable when the queue drains and the source returns.
    if (idx_out >= 0 && !g_stdout_q.used && (fds[idx_out].revents & (POLLIN | POLLHUP))) {
      char buf[65536];
      ssize_t k = read(g_out, buf, sizeof(buf));
      if (k > 0) {
        memcpy(g_stdout_q.data, buf, (size_t)k);
        g_stdout_q.used = (size_t)k;
      }
      if (k == 0) { close(g_out); g_out = -1; }
    }
    if (idx_err >= 0 && !g_stderr_q.used && (fds[idx_err].revents & (POLLIN | POLLHUP))) {
      char buf[65536];
      ssize_t k = read(g_err, buf, sizeof(buf));
      if (k > 0) {
        memcpy(g_stderr_q.data, buf, (size_t)k);
        g_stderr_q.used = (size_t)k;
      }
      if (k == 0) { close(g_err); g_err = -1; }
    }
    if (idx_in >= 0 && (fds[idx_in].revents & POLLOUT) && flush_stdin_to_worker()) stop_worker_stdin();
    if (idx_stdout >= 0 && (fds[idx_stdout].revents & (POLLOUT | POLLERR | POLLHUP)) && flush_queue(1, &g_stdout_q)) return OL_BRIDGE_EXIT_CANCELLED;
    if (idx_stderr >= 0 && (fds[idx_stderr].revents & (POLLOUT | POLLERR | POLLHUP)) && flush_queue(2, &g_stderr_q)) return OL_BRIDGE_EXIT_CANCELLED;
    if (g_exit_pending >= 0 && g_out < 0 && g_err < 0 &&
        g_out_listen < 0 && g_err_listen < 0 && !g_stdout_q.used && !g_stderr_q.used)
      return g_exit_pending;
    // Both payload streams closed and no supervisor verdict in flight: the
    // supervisor's accounting will deliver one; bound the wait so a fully
    // dead supervision chain cannot hang the parent.
    if (g_out < 0 && g_out_listen < 0 && g_err < 0 && g_err_listen < 0 && g_released) {
      static int closed_since = -1;
      if (closed_since < 0) closed_since = (int)time(NULL);
      if ((long)time(NULL) - closed_since > 60) return OL_BRIDGE_EXIT_CANCELLED;
    }
    return -1;
}

static void bridge_relay(const ol_spec_t *spec, const struct timespec *t_start) {
  for (;;) {
    int rc = bridge_poll_once(spec, t_start);
    if (rc >= 0) bridge_exit(rc);
  }
}
