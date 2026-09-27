// owned-launch worker gate — the main executable of the per-run UUID
// launchd worker job created by the supervisor. It is born inside the job's
// own fresh launchd resource coalition (distinct from the supervisor's and
// from the bridge's), which every descendant it later execs inherits.
//
// Contract (README.md): the gate publishes its kernel-issued audit token,
// its resource coalition id, and the boot identity to worker.json, connects
// the private stdio UNIX sockets, and parks on the supervisor's release
// gate. It MUST NOT exec the payload command until the supervisor has
// durably journaled the owned coalition id (owned.json + fsync) and created
// the release marker — so no payload work can ever be released without a
// durable, boot-bound drain obligation existing first.
//
// Diagnostics go to <runDir>/gate.err (launchd's StandardErrorPath is only
// a secondary channel and is never parsed). Failures after publishing write
// gate-exit.json so the supervisor can distinguish an early gate death
// (startup failure) from a natural payload completion.
#include <stdarg.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/wait.h>

#include "owned-launch-common.h"

static const char *g_dir;
static char g_dir_sock[OL_PATH_MAX];

static void diag(const char *fmt, ...) {
  char path[OL_PATH_MAX];
  if ((size_t)snprintf(path, sizeof(path), "%s/gate.err", g_dir) >= sizeof(path)) return;
  int fd = open(path, O_WRONLY | O_CREAT | O_APPEND, 0600);
  if (fd < 0) return;
  va_list ap;
  va_start(ap, fmt);
  char buf[512];
  int n = vsnprintf(buf, sizeof(buf), fmt, ap);
  va_end(ap);
  if (n > 0) (void)write(fd, buf, (size_t)n);
  close(fd);
}

static void record_exit(const char *stage, int code) {
  char path[OL_PATH_MAX], buf[256];
  if ((size_t)snprintf(path, sizeof(path), "%s/gate-exit.json", g_dir) >= sizeof(path)) _exit(code);
  int n = snprintf(buf, sizeof(buf), "role=gate-exit stage=%s errno=%d at=%ld\n",
                   stage, errno, ol_now_sec());
  if (n <= 0 || (size_t)n >= sizeof(buf) ||
      ol_write_atomic(path, buf, (size_t)n, 0600, 1))
    _exit(code);
  _exit(code);
}

static int connect_socket(const char *name) {  char path[OL_PATH_MAX];
  if ((size_t)snprintf(path, sizeof(path), "%s/%s", g_dir_sock, name) >= sizeof(path)) return -1;
  int fd = socket(AF_UNIX, SOCK_STREAM, 0);
  if (fd < 0) return -1;
  struct sockaddr_un addr;
  memset(&addr, 0, sizeof(addr));
  addr.sun_family = AF_UNIX;
  if (strlen(path) >= sizeof(addr.sun_path)) { close(fd); return -1; }
  strncpy(addr.sun_path, path, sizeof(addr.sun_path) - 1);
  // Bound connect: the bridge listens before the supervisor job exists.
  for (int attempt = 0; attempt < 100; attempt++) {
    if (connect(fd, (struct sockaddr *)&addr, sizeof(addr)) == 0) return fd;
    if (errno != ENOENT && errno != ECONNREFUSED) break;
    ol_sleep_ms(100);
  }
  close(fd);
  return -1;
}

int main(int argc, char **argv) {
  umask(077);
  if (argc != 2) return 10;
  g_dir = argv[1];
  ol_spec_t spec;
  if (ol_load_spec(g_dir, &spec)) return 11;
  strncpy(g_dir_sock, spec.sockets_dir, sizeof(g_dir_sock) - 1);

  audit_token_t token;
  uint64_t cid = 0, boot_sec = 0, boot_usec = 0;
  if (ol_self_token(&token) || ol_pid_cid(getpid(), &cid) || cid == 0 ||
      ol_boot_identity(&boot_sec, &boot_usec)) {
    diag("stage=identity errno=%d\n", errno);
    ol_spec_free(&spec);
    return 12;
  }

  // Connect the private stdio sockets BEFORE publishing identity: the gate
  // never reads them, so prompt bytes buffered by the bridge stay queued in
  // the sockets and are consumed by the payload only after the release.
  int in_fd = connect_socket("stdin.sock");
  int out_fd = connect_socket("stdout.sock");
  int err_fd = connect_socket("stderr.sock");
  if (in_fd < 0 || out_fd < 0 || err_fd < 0) {
    diag("stage=stdio errno=%d\n", errno);
    ol_spec_free(&spec);
    record_exit("stdio", 13);
  }

  char path[OL_PATH_MAX], buf[1024];
  if ((size_t)snprintf(path, sizeof(path), "%s/worker.json", g_dir) >= sizeof(path)) {
    ol_spec_free(&spec);
    return 14;
  }
  int n = snprintf(buf, sizeof(buf),
      "role=worker pid=%d pidversion=%d "
      "token=%08x%08x%08x%08x%08x%08x%08x%08x cid=%llx boot=%llu.%06llu start=%ld\n",
      getpid(), audit_token_to_pidversion(token),
      token.val[0], token.val[1], token.val[2], token.val[3],
      token.val[4], token.val[5], token.val[6], token.val[7],
      (unsigned long long)cid, (unsigned long long)boot_sec, (unsigned long long)boot_usec,
      ol_now_sec());
  if (n <= 0 || (size_t)n >= sizeof(buf) ||
      ol_write_atomic(path, buf, (size_t)n, 0600, 1)) {
    ol_spec_free(&spec);
    return 15;
  }

  // Park until the supervisor's durable release. A timeout exits without
  // ever exec'ing: no payload work has been released, and the supervisor's
  // startup watchdog / control EOF handles cleanup.
  if (ol_wait_file(g_dir, "release", spec.release_timeout_seconds)) {
    diag("stage=release-timeout errno=%d\n", errno);
    ol_spec_free(&spec);
    record_exit("release-timeout", 16);
  }
  if (ol_wait_file(g_dir, "cancel", 0) == 0) {
    ol_spec_free(&spec);
    record_exit("cancel", 16);
  }

  // Build a fresh environment from the borrowed spec only: nothing from the
  // launchd job's own environment leaks into the payload.
  char **envp = calloc((size_t)spec.env_count + 1, sizeof(char *));
  if (!envp) { ol_spec_free(&spec); record_exit("env", 17); }
  for (long i = 0; i < spec.env_count; i++) envp[i] = spec.env[i];
  char **cargv = calloc((size_t)spec.args_count + 2, sizeof(char *));
  if (!cargv) { ol_spec_free(&spec); record_exit("argv", 18); }
  cargv[0] = spec.command;
  for (long i = 0; i < spec.args_count; i++) cargv[i + 1] = spec.args[i];

  if (chdir(spec.cwd)) { ol_spec_free(&spec); record_exit("cwd", 19); }

  // Handoff marker immediately before exec: the supervisor treats a drained
  // coalition WITHOUT this marker as a startup failure, never as natural
  // completion. It is written durably because the exec that follows makes
  // the gate's own exit status unobservable to us.
  if ((size_t)snprintf(path, sizeof(path), "%s/gate-handoff", g_dir) >= sizeof(path) ||
      ol_write_atomic(path, "stage=exec\n", strlen("stage=exec\n"), 0600, 1)) {
    ol_spec_free(&spec);
    record_exit("handoff", 20);
  }

  if (dup2(in_fd, 0) == -1 || dup2(out_fd, 1) == -1 || dup2(err_fd, 2) == -1) {
    ol_spec_free(&spec);
    record_exit("dup2", 21);
  }
  pid_t child = fork();
  if (child < 0) record_exit("fork", 22);
  if (child > 0) {
    close(0); close(1); close(2);
    int status = 0;
    while (waitpid(child, &status, 0) < 0) {
      if (errno != EINTR) record_exit("wait", 23);
    }
    char result[128];
    int code = WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
    int count = snprintf(result, sizeof(result), "role=payload-exit code=%d\n", code);
    if ((size_t)snprintf(path, sizeof(path), "%s/payload-exit.json", g_dir) >= sizeof(path) ||
        count <= 0 || ol_write_atomic(path, result, (size_t)count, 0600, 1))
      record_exit("exit-status", 24);
    _exit(0);
  }
  for (int fd = 3; fd < 1024; fd++) close(fd);
  // Match spawn() PATH lookup for bare commands, using only the borrowed
  // payload environment, never launchd's environment.
  extern char **environ;
  environ = envp;
  execvp(spec.command, cargv);
  // exec failed: record and exit. The coalition drains to empty and the
  // supervisor reports a fatal startup failure via the missing handoff.
  diag("stage=exec errno=%d command=%s\n", errno, spec.command);
  record_exit("exec", 127);
}
