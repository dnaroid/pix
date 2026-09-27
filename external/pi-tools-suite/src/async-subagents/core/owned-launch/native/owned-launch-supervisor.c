// owned-launch supervisor — a per-run UUID-labelled launchd job with
// KeepAlive, bootstrapped by the bridge directly into the gui/<uid> domain
// so it is a child of launchd, outside the Pi/bridge lineage. It therefore
// survives simultaneous loss of Pi, the bridge, and the worker payload.
//
// The supervisor owns creation of the worker launchd job itself (the bridge
// never bootstraps the worker), avoiding the bridge-bootstrap race: if the
// bridge dies before the supervisor is ready, no worker job exists yet, and
// if the supervisor dies at any point launchd restarts it and it recovers
// from the journal.
//
// Durable ownership protocol (README.md):
//   1. Connect the bridge's control socket (fail closed if it never
//      appears; nothing has been released).
//   2. Create the UUID worker job whose main program is the worker gate.
//   3. Wait for the gate's worker.json (kernel-issued audit token + the
//      job's fresh resource coalition id + boot identity), then
//      INDEPENDENTLY re-acquire the token and re-read the coalition id of
//      that pid before trusting the file.
//   4. Journal owned.json (boot identity + coalition id + worker identity)
//      with fsync + directory fsync, and only then create the release
//      marker that lets the gate exec the payload. No payload work can be
//      released without a durable, boot-bound drain obligation.
//   5. Monitor: bridge control EOF (Pi/bridge death, including SIGKILL of
//      the whole bridge group), the durable disk cancel marker (written by
//      the launcher's stop() before any signal is attempted; it works with
//      no live bridge, no TS handle, and no signal path at all), supervisor
//      watchdog, or kernel coalition accounting (tasks_started ==
//      tasks_exited) drive everything else.
//
// Drain (cancel, restart recovery, watchdog, or cleanup after natural
// completion): repeatedly enumerate coalition members, and for each member
// acquire its authentic audit token (task_name_for_pid + TASK_AUDIT_TOKEN),
// re-bind it to the owned coalition id (token-before / member-CID /
// token-after), and SIGKILL through proc_signal_with_audittoken only.
// There is no PID-kill fallback and no signal-based liveness probe anywhere
// (signum 0 is EINVAL and SIGUSR1 would terminate default-disposition
// processes). Completion is the kernel oracle
// coalition_info(tasks_started == tasks_exited), never a PID-sweep
// emptiness check. ESRCH for the owned coalition id is success ONLY with
// the durable journal (the kernel removes a coalition from its hash only at
// reap, after the task count reached zero); without durable birth evidence
// it fails closed. Capability mismatches (token acquisition failure,
// unexpected coalition query errno, enumeration failure) are recorded and
// fail the claim unless the kernel oracle still reaches zero.
//
// Restart recovery: if owned.json already exists at startup the supervisor
// NEVER resumes work — it validates the journal against the current boot
// identity and immediately drains (cancel, not resume). A journal from a
// previous boot is fatal: coalition ids are boot-monotonic and must never
// be acted on across a reboot.
//
// Every failure path self-bootouts the supervisor job so KeepAlive cannot
// turn a fatal error into a restart loop, and boots out the owned worker
// job. Receipts (drain.json) are fsynced before any bootout.
//
// Finish ordering and job retirement: finish() durably writes the truthful
// kernel-zero receipt FIRST (it is never rewritten after success — job
// retirement state is tracked separately in retire.json), then sends the
// bridge verdict, then retires the worker job with bounded-backoff bootout
// retries until `launchctl print` confirms the service absent (print
// errors are retried, never ignored). The supervisor self-bootouts only
// after the worker job is confirmed absent; its own bootout cannot be
// self-certified, so integrations must independently verify BOTH UUID
// labels are gone before deleting or reusing run artifacts. A restart that
// finds a terminal receipt (status ok/fail) only retires the jobs — it
// never re-drains and never alters the successful receipt, cause, or
// payload code; it best-effort replays the recorded verdict to a
// still-live bridge (covering a death between receipt and control send).
//
// Fault model (README.md): the 0700 run directory is the sole durable
// journal. External deletion/rename/corruption of it (or of spec.txt /
// owned.json) is OUTSIDE the fault model — it destroys the only drain
// obligation and leaves KeepAlive restarting with nothing to act on.
//
// Test-only barriers: the opt-in launchd tests may stage the two dangerous
// races deterministically by creating `test-hold-pre-release` (parks the
// supervisor inside the bridge-liveness-check → release window) or
// `test-hold-before-retire` (parks it between the durable receipt/verdict
// and job retirement). Entering a hold publishes `test-hold-entered`.
// Holds are bounded (120 s) and can never exist in a production run: the
// launcher creates the fresh 0700 UUID run dir empty.
#define CANCELLED_MSG "{\"type\":\"cancelled\","
#define WORKER_DONE_MSG "{\"type\":\"worker_done\","

#include <poll.h>
#include <stdarg.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/wait.h>

#include "owned-launch-common.h"

static const char *g_dir;
static volatile sig_atomic_t g_alarm = 0;
static volatile sig_atomic_t g_term = 0;

static void on_alarm(int sig) { (void)sig; g_alarm = 1; }
static void on_term(int sig) { (void)sig; g_term = 1; }

// ---------------------------------------------------------- launchctl ----

static int run_launchctl(const char *const argv[]) {
  pid_t pid = fork();
  if (pid < 0) return -1;
  if (pid == 0) {
    const char *env[] = { "PATH=/usr/bin:/bin:/usr/sbin:/sbin", NULL };
    execve("/bin/launchctl", (char *const *)argv, (char *const *)env);
    _exit(127);
  }
  int status = 0;
  if (waitpid(pid, &status, 0) != pid) return -1;
  return WIFEXITED(status) ? WEXITSTATUS(status) : -1;
}

static int service_presence_from_exit(int result) {
  // Only launchctl's exact missing-service result proves retirement.
  if (result == 0) return 1;
  if (result == 113) return 0;
  return -1;
}

static int service_exists(const char *label) {
  char service[256];
  if ((size_t)snprintf(service, sizeof(service), "gui/%d/%s", getuid(), label) >= sizeof(service)) return -1;
  const char *argv[] = { "launchctl", "print", service, NULL };
  return service_presence_from_exit(run_launchctl(argv));
}

static int bootout_service(const char *label) {
  char service[256];
  if ((size_t)snprintf(service, sizeof(service), "gui/%d/%s", getuid(), label) >= sizeof(service)) return -1;
  const char *argv[] = { "launchctl", "bootout", service, NULL };
  return run_launchctl(argv);
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

static int write_plist(const char *path, const char *label, const char *binary,
                       const char *run_dir, int keep_alive) {
  char xl[256], xb[OL_PATH_MAX], xd[OL_PATH_MAX], xo[OL_PATH_MAX];
  xml_escape(label, xl, sizeof(xl));
  xml_escape(binary, xb, sizeof(xb));
  xml_escape(run_dir, xd, sizeof(xd));
  xml_escape(g_dir, xo, sizeof(xo));
  char buf[2 * OL_PATH_MAX];
  int n = snprintf(buf, sizeof(buf),
      "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"
      "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n"
      "<plist version=\"1.0\"><dict><key>Label</key><string>%s</string>"
      "<key>ProgramArguments</key><array><string>%s</string><string>%s</string></array>"
      "<key>RunAtLoad</key><true/><key>KeepAlive</key><%s/>"
      "<key>StandardOutPath</key><string>%s/job.out</string>"
      "<key>StandardErrorPath</key><string>%s/job.err</string></dict></plist>\n",
      xl, xb, xd, keep_alive ? "true" : "false", xo, xo);
  if (n <= 0 || (size_t)n >= sizeof(buf)) return -1;
  return ol_write_atomic(path, buf, (size_t)n, 0600, 1);
}

// ------------------------------------------------------------ control ----

static int g_ctrl = -1;

static int control_connect(const char *sockets_dir, long seconds) {
  char path[OL_PATH_MAX];
  if ((size_t)snprintf(path, sizeof(path), "%s/control.sock", sockets_dir) >= sizeof(path)) return -1;
  struct timespec start;
  clock_gettime(CLOCK_MONOTONIC, &start);
  for (;;) {
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) return -1;
    struct sockaddr_un addr;
    memset(&addr, 0, sizeof(addr));
    addr.sun_family = AF_UNIX;
    if (strlen(path) >= sizeof(addr.sun_path)) { close(fd); return -1; }
    strncpy(addr.sun_path, path, sizeof(addr.sun_path) - 1);
    if (connect(fd, (struct sockaddr *)&addr, sizeof(addr)) == 0) return fd;
    close(fd);
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    if (now.tv_sec - start.tv_sec >= seconds) return -1;
    ol_sleep_ms(100);
  }
}

static int control_send(const char *fmt, ...) {
  if (g_ctrl < 0) return -1;
  char buf[1024];
  va_list ap;
  va_start(ap, fmt);
  int n = vsnprintf(buf, sizeof(buf), fmt, ap);
  va_end(ap);
  if (n <= 0 || (size_t)n >= sizeof(buf)) return -1;
  size_t off = 0;
  while (off < (size_t)n) {
    ssize_t k = write(g_ctrl, buf + off, (size_t)n - off);
    if (k < 0 && errno == EINTR) continue;
    if (k <= 0) return -1; // bridge gone; EOF poll will notice
    off += (size_t)k;
  }
  return 0;
}

// ------------------------------------------------------------ records ----

static int read_line_file(const char *name, char *buf, size_t sz) {
  char path[OL_PATH_MAX];
  if ((size_t)snprintf(path, sizeof(path), "%s/%s", g_dir, name) >= sizeof(path)) return -1;
  int fd = open(path, O_RDONLY | O_NOFOLLOW);
  if (fd < 0) return -1;
  ssize_t n = read(fd, buf, sz - 1);
  int e = errno;
  if (n <= 0 || (size_t)n >= sz) { close(fd); errno = n == 0 ? ENOENT : e; return -1; }
  char extra;
  ssize_t tail = read(fd, &extra, 1);
  close(fd);
  if (tail != 0) return -1;
  buf[n] = '\0';
  if (memchr(buf, '\0', (size_t)n) || buf[n - 1] != '\n') return -1; // strict single line
  return 0;
}

static int marker_present(const char *name) {
  char path[OL_PATH_MAX];
  struct stat st;
  if ((size_t)snprintf(path, sizeof(path), "%s/%s", g_dir, name) >= sizeof(path)) return 0;
  if (lstat(path, &st) != 0) return 0;
  return S_ISREG(st.st_mode); // symlinks and other nonregular entries never count
}

typedef struct {
  pid_t pid;
  int pidversion;
  audit_token_t token;
  uint64_t cid;
  uint64_t boot_sec, boot_usec;
  long start;
} ol_worker_t;

static int parse_worker_record(const char *line, ol_worker_t *w) {
  unsigned int v[8];
  char role[32];
  unsigned long long cid, bs, bu;
  int end = 0;
  memset(w, 0, sizeof(*w));
  int n = sscanf(line,
      "role=%31s pid=%d pidversion=%d token=%8x%8x%8x%8x%8x%8x%8x%8x cid=%llx boot=%llu.%06llu start=%ld%n",
      role, &w->pid, &w->pidversion, &v[0], &v[1], &v[2], &v[3], &v[4], &v[5], &v[6], &v[7],
      &cid, &bs, &bu, &w->start, &end);
  if (n != 15 || strcmp(role, "worker") != 0 || end <= 0 || line[end] != '\n' || line[end + 1] != '\0' || bu >= 1000000 || bs == 0 || w->start <= 0) return -1;
  char exact[1024];
  snprintf(exact, sizeof(exact), "role=worker pid=%d pidversion=%d token=%08x%08x%08x%08x%08x%08x%08x%08x cid=%llx boot=%llu.%06llu start=%ld\n",
           w->pid, w->pidversion, v[0], v[1], v[2], v[3], v[4], v[5], v[6], v[7], cid, bs, bu, w->start);
  if (strcmp(line, exact)) return -1;
  for (int i = 0; i < 8; i++) w->token.val[i] = v[i];
  w->cid = cid;
  w->boot_sec = bs;
  w->boot_usec = bu;
  if (audit_token_to_pid(w->token) != w->pid ||
      audit_token_to_pidversion(w->token) != w->pidversion ||
      w->pid <= 0 || w->pidversion <= 0 || w->cid == 0)
    return -1;
  return 0;
}

typedef struct {
  uint64_t boot_sec, boot_usec, cid;
  pid_t worker_pid;
  int worker_pidversion;
  audit_token_t worker_token;
  long journaled_at;
} ol_owned_t;

static int parse_owned_record(const char *line, ol_owned_t *o) {
  unsigned int v[8];
  char role[32];
  unsigned long long cid, bs, bu;
  int end = 0;
  memset(o, 0, sizeof(*o));
  int n = sscanf(line,
      "role=%31s boot=%llu.%06llu cid=%llx worker_pid=%d worker_pidversion=%d "
      "worker_token=%8x%8x%8x%8x%8x%8x%8x%8x journaled_at=%ld%n",
      role, &bs, &bu, &cid, &o->worker_pid, &o->worker_pidversion,
      &v[0], &v[1], &v[2], &v[3], &v[4], &v[5], &v[6], &v[7], &o->journaled_at, &end);
  if (n != 15 || strcmp(role, "owned") != 0 || end <= 0 || line[end] != '\n' || line[end + 1] != '\0' || bu >= 1000000 || bs == 0 || o->journaled_at <= 0) return -1;
  char exact[1024];
  snprintf(exact, sizeof(exact), "role=owned boot=%llu.%06llu cid=%llx worker_pid=%d worker_pidversion=%d worker_token=%08x%08x%08x%08x%08x%08x%08x%08x journaled_at=%ld\n",
           bs, bu, cid, o->worker_pid, o->worker_pidversion, v[0], v[1], v[2], v[3], v[4], v[5], v[6], v[7], o->journaled_at);
  if (strcmp(line, exact)) return -1;
  for (int i = 0; i < 8; i++) o->worker_token.val[i] = v[i];
  o->cid = cid;
  o->boot_sec = bs;
  o->boot_usec = bu;
  if (audit_token_to_pid(o->worker_token) != o->worker_pid ||
      audit_token_to_pidversion(o->worker_token) != o->worker_pidversion ||
      o->worker_pid <= 0 || o->worker_pidversion <= 0 || o->cid == 0)
    return -1;
  return 0;
}

static int write_owned_journal(const ol_worker_t *w) {
  char path[OL_PATH_MAX], buf[1024];
  if ((size_t)snprintf(path, sizeof(path), "%s/owned.json", g_dir) >= sizeof(path)) return -1;
  int n = snprintf(buf, sizeof(buf),
      "role=owned boot=%llu.%06llu cid=%llx worker_pid=%d worker_pidversion=%d "
      "worker_token=%08x%08x%08x%08x%08x%08x%08x%08x journaled_at=%ld\n",
      (unsigned long long)w->boot_sec, (unsigned long long)w->boot_usec,
      (unsigned long long)w->cid, w->pid, w->pidversion,
      w->token.val[0], w->token.val[1], w->token.val[2], w->token.val[3],
      w->token.val[4], w->token.val[5], w->token.val[6], w->token.val[7],
      ol_now_sec());
  if (n <= 0 || (size_t)n >= sizeof(buf)) return -1;
  // Durable before the release gate exists: fsync file AND directory.
  return ol_write_atomic(path, buf, (size_t)n, 0600, 1);
}

static int payload_exit_code(void) {
  char line[128], exact[128];
  int code = -1, end = 0;
  if (read_line_file("payload-exit.json", line, sizeof(line)) ||
      sscanf(line, "role=payload-exit code=%d%n", &code, &end) != 1 ||
      code < 0 || code > 255 || end <= 0 || line[end] != '\n' || line[end + 1] != '\0') return -1;
  snprintf(exact, sizeof(exact), "role=payload-exit code=%d\n", code);
  return strcmp(line, exact) == 0 ? code : -1;
}

static int write_drain_receipt(const char *status, const char *cause, uint64_t cid,
                                uint64_t started, uint64_t exited, int esrch, int signaled,
                                long iterations, int mismatch, const char *note) {
  char path[OL_PATH_MAX], buf[1024];
  if ((size_t)snprintf(path, sizeof(path), "%s/drain.json", g_dir) >= sizeof(path)) return -1;
  uint64_t bs = 0, bu = 0;
  ol_boot_identity(&bs, &bu);
  uint64_t sup_cid = 0;
  ol_pid_cid(getpid(), &sup_cid);
  int n = snprintf(buf, sizeof(buf),
      "role=drain status=%s cause=%s boot=%llu.%06llu cid=%llx sup_cid=%llx "
      "started=%llu exited=%llu esrch=%d signaled=%d iterations=%ld mismatch=%d payload_code=%d at=%ld%s%s\n",
      status, cause, (unsigned long long)bs, (unsigned long long)bu,
      (unsigned long long)cid, (unsigned long long)sup_cid,
      (unsigned long long)started, (unsigned long long)exited,
      esrch, signaled, iterations, mismatch, payload_exit_code(), ol_now_sec(),
      note ? " note=" : "", note ? note : "");
  if (n <= 0 || (size_t)n >= sizeof(buf)) return -1;
  return ol_write_atomic(path, buf, (size_t)n, 0600, 1);
}

// ------------------------------------------- terminal receipt (retire) ----

typedef struct {
  char status[8];
  char cause[32];
  uint64_t started, exited;
  long payload_code;
} ol_drain_t;

static int token_chars(const char *s, size_t n) {
  if (n == 0) return 0;
  for (size_t i = 0; i < n; i++) {
    char c = s[i];
    if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_' || c == '-')) return 0;
  }
  return 1;
}

// Strict parser for our own drain.json line (see write_drain_receipt).
// The optional tail must be exactly " note=<token>" so a replayed verdict
// can never smuggle extra bytes into the control line.
static int parse_drain_record(const char *line, ol_drain_t *d) {
  unsigned long long bs, bu, cid, sup_cid, started, exited;
  int esrch, signaled, mismatch, code, end = 0;
  long iterations, at;
  memset(d, 0, sizeof(*d));
  int n = sscanf(line,
      "role=drain status=%7s cause=%31s boot=%llu.%06llu cid=%llx sup_cid=%llx "
      "started=%llu exited=%llu esrch=%d signaled=%d iterations=%ld mismatch=%d payload_code=%d at=%ld%n",
      d->status, d->cause, &bs, &bu, &cid, &sup_cid, &started, &exited,
      &esrch, &signaled, &iterations, &mismatch, &code, &at, &end);
  if (n != 14 || end <= 0 || bu >= 1000000 || bs == 0) return -1;
  if (line[end] == '\n') {
    if (line[end + 1] != '\0') return -1;
  } else {
    if (strncmp(line + end, " note=", 6) != 0) return -1;
    const char *p = line + end + 6;
    const char *nl = strchr(p, '\n');
    if (!nl || nl[1] != '\0' || !token_chars(p, (size_t)(nl - p))) return -1;
  }
  if (!token_chars(d->status, strlen(d->status)) || !token_chars(d->cause, strlen(d->cause)) ||
      (strcmp(d->status, "ok") != 0 && strcmp(d->status, "fail") != 0 && strcmp(d->status, "retry") != 0) ||
      esrch < 0 || esrch > 1 || code < -1 || code > 255)
    return -1;
  d->started = started;
  d->exited = exited;
  d->payload_code = code;
  return 0;
}

static int read_drain_record(ol_drain_t *d) {
  char line[1024];
  if (read_line_file("drain.json", line, sizeof(line))) return -1;
  return parse_drain_record(line, d);
}

// ------------------------------------------------------------- retire ----

// Retire the owned worker job: bounded-backoff bootout retries until
// `launchctl print` CONFIRMS the service absent. service_exists errors
// (print failed to run) are retried, never ignored — an unreadable answer
// is treated as still-present so a live job can never be abandoned by an
// unlucky launchctl failure. Returns 1 when confirmed absent; 0 when
// unconfirmed after the bound (a retire.json diagnostic is written and
// KeepAlive ownership is retained so the next restart retries).
static int retire_worker_job(const ol_spec_t *spec) {
  if (!spec->label_worker[0]) return 1;
  long waited_ms = 0, delay_ms = 200;
  for (;;) {
    if (service_exists(spec->label_worker) == 0) return 1;
    (void)bootout_service(spec->label_worker); // idempotent; verified by the print above/below
    if (waited_ms >= 30000) {
      char path[OL_PATH_MAX], buf[256];
      if ((size_t)snprintf(path, sizeof(path), "%s/retire.json", g_dir) < sizeof(path)) {
        int n = snprintf(buf, sizeof(buf), "role=retire note=worker_retire_unconfirmed at=%ld\n", ol_now_sec());
        if (n > 0 && (size_t)n < sizeof(buf)) (void)ol_write_atomic(path, buf, (size_t)n, 0600, 1);
      }
      return 0;
    }
    ol_sleep_ms(delay_ms);
    waited_ms += delay_ms;
    if (delay_ms < 3200) delay_ms *= 2;
  }
}

// Test-only deterministic barrier (never present in a production run; see
// the file header). Parks at a precise lifecycle point and publishes
// test-hold-entered so tests can stage exact races without guessed delays.
// Bounded so even a stray file cannot park a KeepAlive job forever.
static void hold_for_test(const char *name) {
  if (!marker_present(name)) return;
  char entered[OL_PATH_MAX], buf[128];
  if ((size_t)snprintf(entered, sizeof(entered), "%s/test-hold-entered", g_dir) < sizeof(entered)) {
    int n = snprintf(buf, sizeof(buf), "hold=%s at=%ld\n", name, ol_now_sec());
    if (n > 0 && (size_t)n < sizeof(buf)) (void)ol_write_atomic(entered, buf, (size_t)n, 0600, 0);
  }
  for (long waited_ms = 0; marker_present(name); ol_sleep_ms(50)) {
    waited_ms += 50;
    if (waited_ms >= 120000) break;
  }
}

// -------------------------------------------------------------- drain ----

// Returns 0 when the kernel oracle confirms zero live members (started ==
// exited, or ESRCH backed by the durable journal), -1 otherwise. mismatch
// counts capability failures; they fail the claim unless the oracle still
// reaches zero, so a transient unreadable zombie can never produce a false
// failure verdict after kernel-zero, and a genuine denial can never be
// reported as success.
static int drain_coalition(uint64_t cid, long deadline_s, int journal_durable,
                           uint64_t *started, uint64_t *exited, int *esrch,
                           int *signaled, long *iterations, int *mismatch) {
  struct timespec t0;
  clock_gettime(CLOCK_MONOTONIC, &t0);
  for (;;) {
    (*iterations)++;
    pid_t members[512];
    int n = ol_members(cid, members, 512);
    if (n < 0) {
      (*mismatch)++;
    } else {
      for (int i = 0; i < n; i++) {
        audit_token_t tok;
        // token-before: authentic kernel-issued token for this member.
        if (ol_pid_token(members[i], &tok)) {
          // Capability mismatch only if the pid is still a live member we
          // cannot tokenize; otherwise it is gone/zombie — skip, never signal.
          uint64_t c = 0;
          if (ol_pid_cid(members[i], &c) == 0 && c == cid) (*mismatch)++;
          continue;
        }
        // token-after binding: the pid must STILL belong to the owned
        // coalition; a recycled pid now owned by someone else is never
        // signaled. The token itself carries the exact generation the
        // kernel validates atomically at signal time.
        uint64_t c2 = 0;
        if (ol_pid_cid(members[i], &c2) || c2 != cid) continue;
        audit_token_t after;
        if (ol_pid_token(members[i], &after) ||
            memcmp(tok.val, after.val, sizeof(tok.val)) != 0) {
          (*mismatch)++;
          continue;
        }
        errno = 0;
        int r = ol_token_kill(&tok);
        if (r == 0 || errno == ESRCH) (*signaled)++; // delivered, or that exact generation already ended
        else (*mismatch)++;
      }
    }
    int err = 0;
    int q = ol_coalition_usage(cid, started, exited, &err);
    if (q == 0 && *started == *exited) return 0; // kernel-zero receipt
    if (q == 3) {
      *esrch = 1;
      return journal_durable ? 0 : -1;
    }
    if (q < 0) (*mismatch)++;
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    if (now.tv_sec - t0.tv_sec >= deadline_s) return -1;
    ol_sleep_ms(100);
  }
}

// ----------------------------------------------------------- lifecycle ---

static int finish(const char *status, const char *cause, const ol_spec_t *spec,
                  uint64_t cid, uint64_t started, uint64_t exited, int esrh_v,
                  int signaled, long iterations, int mismatch, int code,
                  const char *bridge_msg, const char *note) {
  int natural = bridge_msg && strcmp(bridge_msg, WORKER_DONE_MSG) == 0;
  int payload_code = natural ? payload_exit_code() : -1;
  if (natural && payload_code < 0) status = "fail";
  // Truthful kernel-zero receipt FIRST, durable before any teardown, and
  // never rewritten afterwards: job retirement is tracked separately
  // (retire.json) so a retirement failure can never alter a successful
  // receipt, cause, or payload code.
  while (write_drain_receipt(status, cause, cid, started, exited, esrh_v, signaled, iterations, mismatch, note)) ol_sleep_ms(1000);
  if (g_ctrl >= 0 && bridge_msg) {
    if (natural) {
      if (payload_code >= 0) {
        (void)control_send("%s\"cause\":\"%s\",\"code\":%d,\"started\":%llu,\"exited\":%llu}\n",
                           bridge_msg, cause, payload_code, (unsigned long long)started, (unsigned long long)exited);
      } else (void)control_send("{\"type\":\"fatal\",\"cause\":\"missing-exit-status\"}\n");
    } else (void)control_send("%s\"cause\":\"%s\",\"started\":%llu,\"exited\":%llu}\n",
                              bridge_msg, cause, (unsigned long long)started, (unsigned long long)exited);
  }
  if (g_ctrl >= 0) { (void)shutdown(g_ctrl, SHUT_WR); ol_sleep_ms(50); close(g_ctrl); g_ctrl = -1; }
  // Test-only deterministic park between the durable receipt/verdict and
  // job retirement (stages the crash window of finding 2 exactly).
  hold_for_test("test-hold-before-retire");
  if (spec && spec->label_worker[0] && !retire_worker_job(spec)) {
    // Worker retirement unconfirmed: NEVER self-bootout (that would leave
    // an owned job installed with nobody to retire it). The durable
    // receipt already records the truthful outcome; KeepAlive ownership is
    // retained and every restart retries retirement via the terminal-
    // receipt path without touching the receipt.
    return code;
  }
  if (spec && spec->label_supervisor[0]) {
    signal(SIGTERM, SIG_DFL); // self-bootout is terminal; never re-enter cancel
    (void)bootout_service(spec->label_supervisor);
  }
  return code;
}

// Shared drain-and-finish for the cancel-style paths. `bridge_msg` selects
// the verdict the bridge applies (cancelled vs worker_done: a natural
// leader exit cleans survivors but is still a successful completion).
static int cancel_and_finish_with_birth(const ol_spec_t *spec, uint64_t cid, const char *cause,
                                        const char *bridge_msg, int journal_durable) {
  uint64_t s = 0, e = 0;
  int es = 0, si = 0, mi = 0;
  long it = 0;
  char path[OL_PATH_MAX];
  if ((size_t)snprintf(path, sizeof(path), "%s/cancel", g_dir) < sizeof(path))
    (void)ol_write_atomic(path, "stage=cancel\n", 13, 0600, 1);
  // KeepAlive is the durable retry owner: NEVER self-bootout on a timeout
  // or an unknown kernel answer while members may still be running.
  while (drain_coalition(cid, spec->drain_deadline_seconds, journal_durable, &s, &e, &es, &si, &it, &mi)) {
    (void)write_drain_receipt("retry", cause, cid, s, e, es, si, it, mi, "drain_not_confirmed");
    ol_sleep_ms(1000);
  }
  return finish(strstr(bridge_msg, "\"fatal\"") ? "fail" : "ok", cause, spec, cid, s, e, es, si, it, mi,
                0, bridge_msg, NULL);
}

static int cancel_and_finish(const ol_spec_t *spec, uint64_t cid, const char *cause,
                             const char *bridge_msg) {
  return cancel_and_finish_with_birth(spec, cid, cause, bridge_msg, 1);
}

static int fail_closed(const ol_spec_t *spec, const char *cause, const char *note) {
  char line[1024];
  ol_owned_t owned;
  if (read_line_file("owned.json", line, sizeof(line)) == 0) {
    if (parse_owned_record(line, &owned) == 0)
      return cancel_and_finish_with_birth(spec, owned.cid, cause, "{\"type\":\"fatal\",",
                                          strcmp(cause, "journal-write") != 0);
    // A release may have happened before a crash or a failed directory fsync.
    // With no trustworthy CID, relinquishing KeepAlive would abandon work.
    if (marker_present("release")) for (;;) ol_sleep_ms(1000);
  }
  return finish("fail", cause, spec, 0, 0, 0, 0, 0, 0, 0, 1, "{\"type\":\"fatal\",", note);
}

// Best-effort replay of the verdict a previous instance recorded durably
// but may have died before delivering (between the receipt write and the
// control send). cause/status are strictly token-validated by the parser,
// so they cannot smuggle bytes into the control line.
static void replay_terminal_verdict(const ol_drain_t *rec) {
  if (g_ctrl < 0) return;
  if (strcmp(rec->status, "ok") == 0 &&
      (strcmp(rec->cause, "natural") == 0 || strcmp(rec->cause, "leader_exit") == 0)) {
    if (rec->payload_code >= 0 && rec->payload_code <= 255)
      (void)control_send("{\"type\":\"worker_done\",\"cause\":\"%s\",\"code\":%ld,\"started\":%llu,\"exited\":%llu}\n",
                         rec->cause, rec->payload_code, (unsigned long long)rec->started, (unsigned long long)rec->exited);
    else
      (void)control_send("{\"type\":\"fatal\",\"cause\":\"missing-exit-status\"}\n");
  } else if (strcmp(rec->status, "ok") == 0) {
    (void)control_send("%s\"cause\":\"%s\",\"started\":%llu,\"exited\":%llu}\n",
                       CANCELLED_MSG, rec->cause, (unsigned long long)rec->started, (unsigned long long)rec->exited);
  } else {
    (void)control_send("{\"type\":\"fatal\",\"cause\":\"%s\",\"started\":%llu,\"exited\":%llu}\n",
                       rec->cause, (unsigned long long)rec->started, (unsigned long long)rec->exited);
  }
}

// A terminal drain receipt (status ok/fail) already exists: a previous
// instance concluded this run with a durable kernel receipt. Retirement of
// the launchd jobs is the only remaining obligation — never re-drain,
// never resume, and never rewrite the successful receipt (cause/payload
// code included). Returns 0 after self-bootout; 2 when worker retirement
// stayed unconfirmed (KeepAlive retains ownership; the next restart
// retries this exact path).
static int retire_after_terminal(const ol_spec_t *spec, const ol_drain_t *rec) {
  g_ctrl = control_connect(spec->sockets_dir, 10);
  if (g_ctrl >= 0) {
    replay_terminal_verdict(rec);
    (void)shutdown(g_ctrl, SHUT_WR);
    ol_sleep_ms(50);
    close(g_ctrl);
    g_ctrl = -1;
  }
  if (!retire_worker_job(spec)) return 2;
  if (spec->label_supervisor[0]) {
    signal(SIGTERM, SIG_DFL); // self-bootout is terminal; never re-enter cancel
    (void)bootout_service(spec->label_supervisor);
  }
  return 0;
}

static int bridge_disconnected(void) {
  struct pollfd fd = { .fd = g_ctrl, .events = POLLIN };
  if (g_ctrl < 0) return 1;
  int r = poll(&fd, 1, 0);
  if (r < 0) return errno != EINTR;
  if (!r) return 0;
  char c;
  ssize_t n = recv(g_ctrl, &c, 1, MSG_PEEK | MSG_DONTWAIT);
  return n == 0 || (n < 0 && errno != EAGAIN && errno != EINTR);
}

int main(int argc, char **argv) {
  umask(077);
  setvbuf(stdout, NULL, _IONBF, 0);
  if (argc != 2) return 10;
  g_dir = argv[1];
  ol_spec_t spec;
  if (ol_load_spec(g_dir, &spec)) return 11;

  signal(SIGALRM, on_alarm);
  signal(SIGTERM, on_term);
  signal(SIGPIPE, SIG_IGN);
  alarm((unsigned)(spec.watchdog_seconds + 30)); // hard liveness backstop only

  struct timespec t_start;
  clock_gettime(CLOCK_MONOTONIC, &t_start);
  uint64_t boot_sec = 0, boot_usec = 0;
  if (ol_boot_identity(&boot_sec, &boot_usec)) {
    ol_spec_free(&spec);
    return 12;
  }
  uint64_t sup_cid = 0;
  if (ol_pid_cid(getpid(), &sup_cid)) {
    ol_spec_free(&spec);
    return 13;
  }

  // ------------------------------------------------ restart recovery ----
  char line[1024];
  // Terminal receipt first: a previous instance already concluded this run
  // with a durable kernel receipt. Only job retirement remains, and it must
  // not alter the successful receipt/cause/payload code.
  {
    ol_drain_t rec;
    if (read_drain_record(&rec) == 0 && strcmp(rec.status, "retry") != 0) {
      int rc = retire_after_terminal(&spec, &rec);
      ol_spec_free(&spec);
      return rc;
    }
  }
  if (read_line_file("owned.json", line, sizeof(line)) == 0) {
    // A durable ownership obligation already exists: never resume, cancel.
    ol_owned_t owned;
    if (parse_owned_record(line, &owned) ||
        owned.boot_sec != boot_sec || owned.boot_usec != boot_usec || owned.cid == sup_cid) {
      // Unparseable journal, or a journal from a previous boot: coalition
      // ids are boot-monotonic; acting on a cross-boot id is forbidden. No
      // signal is ever sent; fail closed and remove ourselves so KeepAlive
      // cannot loop.
      (void)write_drain_receipt("fail", "journal-invalid", 0, 0, 0, 0, 0, 0, 0, "journal_parse_or_boot_mismatch");
      if (marker_present("release")) for (;;) ol_sleep_ms(1000);
      if (!retire_worker_job(&spec)) { ol_spec_free(&spec); return 2; }
      signal(SIGTERM, SIG_DFL);
      (void)bootout_service(spec.label_supervisor);
      ol_spec_free(&spec);
      return 1;
    }
    g_ctrl = control_connect(spec.sockets_dir, 10);
    int rc = cancel_and_finish(&spec, owned.cid, "restart_recovery", CANCELLED_MSG);
    ol_spec_free(&spec);
    return rc;
  }

  // ------------------------------------------------------ fresh start ----
  // Integrity: a release marker without a journal means corruption; without
  // the journal there is no durable birth evidence, so nothing may be
  // signaled or claimed. Fail closed.
  if (marker_present("release")) {
    int rc = fail_closed(&spec, "release-without-journal", "no_durable_birth_evidence");
    ol_spec_free(&spec);
    return rc;
  }

  // Control first: the bridge must be alive before any worker job exists.
  g_ctrl = control_connect(spec.sockets_dir, 10);
  if (g_ctrl < 0) {
    int rc = fail_closed(&spec, "no-bridge", "control_socket_unreachable");
    ol_spec_free(&spec);
    return rc;
  }
  (void)control_send("{\"type\":\"supervisor_hello\",\"pid\":%d}\n", getpid());

  // Supervisor-owned worker job creation (never the bridge).
  int exists = service_exists(spec.label_worker);
  if (exists < 0) {
    int rc = fail_closed(&spec, "launchctl", "print_failed");
    ol_spec_free(&spec);
    return rc;
  }
  if (!exists) {
    char plist_path[OL_PATH_MAX];
    if ((size_t)snprintf(plist_path, sizeof(plist_path), "%s/job-worker.plist", g_dir) >= sizeof(plist_path) ||
        write_plist(plist_path, spec.label_worker, spec.gate_binary, g_dir, 0)) {
      int rc = fail_closed(&spec, "worker-plist", "plist_write_failed");
      ol_spec_free(&spec);
      return rc;
    }
    char domain[64];
    (void)snprintf(domain, sizeof(domain), "gui/%d", getuid());
    const char *bargv[] = { "launchctl", "bootstrap", domain, plist_path, NULL };
    int r = run_launchctl(bargv);
    if (r != 0 && service_exists(spec.label_worker) != 1) {
      int rc = fail_closed(&spec, "worker-bootstrap", "bootstrap_failed");
      ol_spec_free(&spec);
      return rc;
    }
  }

  // Wait for the gate's published identity within the release timeout.
  ol_worker_t worker;
  int have_worker = 0;
  if (ol_wait_file(g_dir, "worker.json", spec.release_timeout_seconds) == 0 &&
      read_line_file("worker.json", line, sizeof(line)) == 0 &&
      parse_worker_record(line, &worker) == 0)
    have_worker = 1;
  if (!have_worker) {
    // No identity, no journal: nothing may be signaled. The worker job is
    // removed while its gate can only be parked pre-release (no payload).
    int rc = fail_closed(&spec, "no-worker-identity", "worker_json_missing_or_invalid");
    ol_spec_free(&spec);
    return rc;
  }

  // Independent validation: re-acquire the authentic token and re-read the
  // coalition id for the published pid now; both must match the record, the
  // boot identity must match, and the coalition must be the job's own (not
  // the supervisor's).
  audit_token_t live_token;
  uint64_t live_cid = 0;
  if (ol_pid_token(worker.pid, &live_token) ||
      memcmp(live_token.val, worker.token.val, sizeof(live_token.val)) != 0 ||
      ol_pid_cid(worker.pid, &live_cid) || live_cid != worker.cid ||
      worker.boot_sec != boot_sec || worker.boot_usec != boot_usec ||
      worker.cid == sup_cid) {
    int rc = fail_closed(&spec, "worker-identity-mismatch", "reacquired_identity_differs");
    ol_spec_free(&spec);
    return rc;
  }

  // Durable journal BEFORE the release gate.
  if (write_owned_journal(&worker)) {
    int rc = fail_closed(&spec, "journal-write", "owned_json_write_failed");
    ol_spec_free(&spec);
    return rc;
  }
  if (g_term || g_alarm || bridge_disconnected() || marker_present("cancel")) {
    // Startup-phase cancel: SIGTERM, watchdog, bridge loss, or the durable
    // disk cancel marker (stop() writes it before attempting any signal,
    // so this leg works with no live bridge and no TS handle at all).
    int rc = cancel_and_finish(&spec, worker.cid, "startup-cancel", CANCELLED_MSG);
    ol_spec_free(&spec);
    return rc;
  }
  // Test-only park INSIDE the bridge-liveness-check → release window: that
  // window is genuinely non-atomic (a re-check would only shrink it), and
  // containment after a lost race is the EOF drain, staged deterministically
  // here. Production runs never create this file.
  hold_for_test("test-hold-pre-release");
  char release_path[OL_PATH_MAX];
  if ((size_t)snprintf(release_path, sizeof(release_path), "%s/release", g_dir) >= sizeof(release_path) ||
      ol_write_atomic(release_path, "stage=release\n", strlen("stage=release\n"), 0600, 1)) {
    int rc = fail_closed(&spec, "release-write", "release_marker_failed");
    ol_spec_free(&spec);
    return rc;
  }
  (void)control_send("{\"type\":\"worker_released\",\"cid\":\"%llx\",\"worker_pid\":%d}\n",
                     (unsigned long long)worker.cid, worker.pid);

  // ------------------------------------------------------- monitoring ----
  int signaled = 0, mismatch = 0;
  long iterations = 0;
  long leader_checks = 0;
  for (;;) {
    if (g_term || marker_present("cancel")) {
      // SIGTERM to the supervisor, or the durable disk cancel marker —
      // polled every iteration so a marker written by stop() (or any
      // authorized writer with no bridge/signal path at all) cancels
      // promptly even while the control socket is fully healthy.
      int rc = cancel_and_finish(&spec, worker.cid, "cancel", CANCELLED_MSG);
      ol_spec_free(&spec);
      return rc;
    }
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    if (g_alarm || now.tv_sec - t_start.tv_sec >= spec.watchdog_seconds) {
      int rc = cancel_and_finish(&spec, worker.cid, "watchdog", CANCELLED_MSG);
      ol_spec_free(&spec);
      return rc;
    }
    // Natural leader exit: the gate exec'd the payload in-place, so the
    // leader IS worker.pid with worker.pidversion. A generation-checked
    // read (never a signal, never a bare-PID decision: a recycled pid
    // carries a different pidversion and is never mistaken for the leader)
    // detects that the leader generation ended; remaining coalition
    // members — including setsid'd TERM-resistant descendants — are then
    // drained by exact-token SIGKILL to a kernel-zero receipt.
    if (++leader_checks >= 5) {
      leader_checks = 0;
      int32_t pv = 0;
      int leader_gone = ol_pid_pidversion(worker.pid, &pv) != 0 || pv != worker.pidversion;
      if (leader_gone) {
        if (marker_present("gate-exit.json")) {
          int rc = cancel_and_finish(&spec, worker.cid, "worker-exec-fail", "{\"type\":\"fatal\",");
          ol_spec_free(&spec);
          return rc;
        }
        if (!marker_present("gate-handoff")) {
          int rc = cancel_and_finish(&spec, worker.cid, "gate-early-exit", "{\"type\":\"fatal\",");
          ol_spec_free(&spec);
          return rc;
        }
        int rc = cancel_and_finish(&spec, worker.cid, "leader_exit", WORKER_DONE_MSG);
        ol_spec_free(&spec);
        return rc;
      }
    }
    // Bridge liveness: control EOF means Pi/bridge loss (including SIGKILL
    // of the bridge's whole group). That is the containment trigger.
    struct pollfd pfd = { .fd = g_ctrl, .events = POLLIN };
    int pr = poll(&pfd, 1, 100);
    if (pr < 0 && errno != EINTR) {
      int rc = cancel_and_finish(&spec, worker.cid, "control-poll", "{\"type\":\"fatal\",");
      ol_spec_free(&spec);
      return rc;
    }
    if (pr > 0 && (pfd.revents & (POLLIN | POLLHUP | POLLERR))) {
      char c;
      ssize_t k = read(g_ctrl, &c, 1);
      if (k <= 0) {
        // EOF (or error): Pi/bridge loss. Drain the owned coalition.
        int rc = cancel_and_finish(&spec, worker.cid, "cancel", CANCELLED_MSG);
        ol_spec_free(&spec);
        return rc;
      }
      // k > 0: bridge message bytes (e.g. a stop intent line). The cancel
      // decision stays with EOF/watchdog/kernel accounting; content is not
      // trusted for lifecycle decisions.
    }
    int err = 0;
    uint64_t s = 0, e = 0;
    int q = ol_coalition_usage(worker.cid, &s, &e, &err);
    if (q == 0 && s == e && s > 0) {
      // Kernel oracle: the coalition is empty. Distinguish an honest
      // payload completion from a gate death before the exec handoff.
      if (marker_present("gate-exit.json")) {
        int rc = finish("fail", "worker-exec-fail", &spec, worker.cid, s, e, 0, signaled, iterations, mismatch, 1,
                        "{\"type\":\"fatal\",", "gate_reported_exec_failure");
        ol_spec_free(&spec);
        return rc;
      }
      if (!marker_present("gate-handoff")) {
        int rc = finish("fail", "gate-early-exit", &spec, worker.cid, s, e, 0, signaled, iterations, mismatch, 1,
                        "{\"type\":\"fatal\",", "no_handoff_marker");
        ol_spec_free(&spec);
        return rc;
      }
      int rc = finish("ok", "natural", &spec, worker.cid, s, e, 0, signaled, iterations, mismatch, 0,
                      "{\"type\":\"worker_done\",", NULL);
      ol_spec_free(&spec);
      return rc;
    }
    if (q == 3) {
      // The durable journal exists (written above), so ESRCH is the
      // kernel's reaped-and-zero receipt rather than "never existed".
      if (marker_present("gate-exit.json") || !marker_present("gate-handoff")) {
        int rc = finish("fail", "gate-early-exit", &spec, worker.cid, 0, 0, 1, signaled, iterations, mismatch, 1,
                        "{\"type\":\"fatal\",", "esrch_before_payload_handoff");
        ol_spec_free(&spec);
        return rc;
      }
      int rc = finish("ok", "natural", &spec, worker.cid, s, e, 1, signaled, iterations, mismatch, 0,
                      "{\"type\":\"worker_done\",", "esrch_reaped");
      ol_spec_free(&spec);
      return rc;
    }
    if (q < 0) {
      mismatch++;
      if (mismatch > 100) {
        int rc = cancel_and_finish(&spec, worker.cid, "capability", "{\"type\":\"fatal\",");
        ol_spec_free(&spec);
        return rc;
      }
    }
  }
}
