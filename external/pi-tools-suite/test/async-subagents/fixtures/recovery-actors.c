// macOS-only offline fixture for the joint owner-loss recovery experiment.
// Cooperative fake actors (stated limitation: they voluntarily publish their
// own kernel-issued audit token; a hostile descendant would not).
//
// Topology: app (direct harness child) -> helper (direct app child)
//   -> leaf fork child that setsid()+exec()s into its own session/group and is
//   reparented to launchd when the helper dies. The leaf is the known fake
//   descendant that survives joint app/helper loss.
//
// Kills target only a recorded fork child (app's helper) or an audit-token
// generation validated by the supervisor fixture. No PID enumeration, no
// unvalidated PID/group kills. Every actor has an independent alarm backstop.
#include <bsm/libbsm.h>
#include <errno.h>
#include <fcntl.h>
#include <libproc.h>
#include <mach/mach.h>
#include <mach/task_info.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static const char *g_dir;
static const char *g_self;

// Cooperating-actor limitation: every actor ignores SIGUSR1 so the recovery
// supervisor can use it as a generation-safe liveness probe. On this host
// proc_signal_with_audittoken rejects signum 0 with EINVAL, so there is no
// truly inert probe signal. Lethal delivery is only exact-generation SIGKILL.
static void ignore_probe_signal(void) {
  if (signal(SIGUSR1, SIG_IGN) == SIG_ERR) _exit(19);
}

static int write_atomic(const char *path, const char *buf, size_t len) {
  char tmp[4096];
  if ((size_t)snprintf(tmp, sizeof(tmp), "%s.tmp", path) >= sizeof(tmp)) return -1;
  int fd = open(tmp, O_WRONLY | O_CREAT | O_TRUNC, 0644);
  if (fd < 0) return -1;
  size_t off = 0;
  while (off < len) {
    ssize_t k = write(fd, buf + off, len - off);
    if (k <= 0) { close(fd); return -1; }
    off += (size_t)k;
  }
  if (fsync(fd)) { close(fd); return -1; }
  if (close(fd)) return -1;
  return rename(tmp, path);
}

static void publish_token(const char *role, long backstop_seconds) {
  audit_token_t token;
  mach_msg_type_number_t count = TASK_AUDIT_TOKEN_COUNT;
  if (task_info(mach_task_self(), TASK_AUDIT_TOKEN, (task_info_t)&token, &count) != KERN_SUCCESS ||
      count != TASK_AUDIT_TOKEN_COUNT) _exit(20);
  char path[4096], buf[512];
  long now = time(NULL);
  if ((size_t)snprintf(path, sizeof(path), "%s/%s.json", g_dir, role) >= sizeof(path)) _exit(21);
  int n = snprintf(buf, sizeof(buf),
      "role=%s pid=%d pidversion=%d "
      "token=%08x%08x%08x%08x%08x%08x%08x%08x start=%ld deadline=%ld\n",
      role, getpid(), audit_token_to_pidversion(token),
      token.val[0], token.val[1], token.val[2], token.val[3],
      token.val[4], token.val[5], token.val[6], token.val[7],
      now, now + backstop_seconds);
  if (n <= 0 || (size_t)n >= sizeof(buf) || write_atomic(path, buf, (size_t)n)) _exit(22);
}

static void sleep_ms(long ms) {
  struct timespec ts = { ms / 1000, (ms % 1000) * 1000000L };
  nanosleep(&ts, NULL);
}

static int wait_file(const char *name, long seconds) {
  char path[4096];
  if ((size_t)snprintf(path, sizeof(path), "%s/%s", g_dir, name) >= sizeof(path)) return -1;
  struct timespec start, now;
  clock_gettime(CLOCK_MONOTONIC, &start);
  for (;;) {
    if (access(path, R_OK) == 0) return 0;
    clock_gettime(CLOCK_MONOTONIC, &now);
    if (now.tv_sec - start.tv_sec >= seconds) return -1;
    sleep_ms(20);
  }
}

static int run_app(void) {
  ignore_probe_signal();
  alarm(20);
  publish_token("app", 20);
  pid_t helper = fork();
  if (helper < 0) return 11;
  if (helper == 0) {
    alarm(20);
    execl(g_self, g_self, "helper", g_dir, (char *)NULL);
    _exit(12);
  }
  // Deterministic handshake: the harness drops this marker file to command the
  // app to remove its *direct waitable* helper child; no other PID is targeted.
  if (wait_file("kill-helper", 15)) return 13;
  errno = 0;
  int killed = kill(helper, SIGKILL);
  int killed_errno = errno;
  int status = 0;
  if (killed || waitpid(helper, &status, 0) != helper) return 14;
  char path[4096], buf[256];
  if ((size_t)snprintf(path, sizeof(path), "%s/helper-killed.json", g_dir) >= sizeof(path)) return 15;
  int n = snprintf(buf, sizeof(buf), "pid=%d signal=%d errno=%d\n", helper,
                   WIFSIGNALED(status) ? WTERMSIG(status) : 0, killed_errno);
  if (n <= 0 || (size_t)n >= sizeof(buf) || write_atomic(path, buf, (size_t)n)) return 16;
  for (;;) pause();
  return 0;
}

static void run_helper(void) {
  ignore_probe_signal();
  alarm(20);
  pid_t leaf = fork();
  if (leaf < 0) _exit(17);
  if (leaf == 0) {
    alarm(25); // leaf's own independent watchdog; recovery must beat it
    if (setsid() == -1) _exit(18);
    execl(g_self, g_self, "leaf", g_dir, (char *)NULL);
    _exit(19);
  }
  publish_token("helper", 20);
  for (;;) pause();
}

static void run_leaf(void) {
  ignore_probe_signal();
  alarm(25);
  publish_token("leaf", 25);
  for (;;) pause();
}

int main(int argc, char **argv) {
  setvbuf(stdout, NULL, _IONBF, 0);
  if (argc != 3) return 10;
  if (signal(SIGCHLD, SIG_DFL) == SIG_ERR) return 10;
  g_self = argv[0];
  g_dir = argv[2];
  if (strcmp(argv[1], "app") == 0) return run_app();
  if (strcmp(argv[1], "helper") == 0) { run_helper(); return 0; }
  if (strcmp(argv[1], "leaf") == 0) { run_leaf(); return 0; }
  return 10;
}
