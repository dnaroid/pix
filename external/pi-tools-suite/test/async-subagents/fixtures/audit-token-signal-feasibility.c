// macOS-only test fixture. Never enumerate PIDs; only signal an unreaped direct child.
#include <bsm/libbsm.h>
#include <errno.h>
#include <libproc.h>
#include <mach/mach.h>
#include <mach/task_info.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

static int write_all(int fd, const void *buf, size_t n) {
  const char *p = buf;
  while (n) {
    ssize_t k = write(fd, p, n);
    if (k <= 0) return -1;
    p += k;
    n -= (size_t)k;
  }
  return 0;
}

static int read_all(int fd, void *buf, size_t n) {
  char *p = buf;
  while (n) {
    ssize_t k = read(fd, p, n);
    if (k <= 0) return -1;
    p += k;
    n -= (size_t)k;
  }
  return 0;
}

int main(void) {
  int pipefd[2];
  if (pipe(pipefd)) return 10;
  alarm(15);
  pid_t child = fork();
  if (child < 0) return 11;
  if (!child) {
    close(pipefd[0]);
    alarm(8); // independently expires even if the runner/parent disappears
    audit_token_t token;
    mach_msg_type_number_t count = TASK_AUDIT_TOKEN_COUNT;
    if (task_info(mach_task_self(), TASK_AUDIT_TOKEN, (task_info_t)&token, &count) != KERN_SUCCESS ||
        count != TASK_AUDIT_TOKEN_COUNT || write_all(pipefd[1], &token, sizeof(token))) _exit(12);
    close(pipefd[1]);
    for (;;) pause();
  }
  close(pipefd[1]);
  audit_token_t exact;
  int status = 0, result = 0;
  if (read_all(pipefd[0], &exact, sizeof(exact)) || audit_token_to_pid(exact) != child ||
      audit_token_to_pidversion(exact) <= 0) { result = 13; goto cleanup; }
  close(pipefd[0]);

  // Apple mach/message.h defines val[8]; verify with Apple's public libbsm
  // accessor that this mutation changes *only* the PID generation.
  audit_token_t wrong = exact;
  wrong.val[7]++;
  if (audit_token_to_pid(wrong) != child ||
      audit_token_to_pidversion(wrong) == audit_token_to_pidversion(exact)) {
    result = 14; goto cleanup;
  }
  errno = 0;
  int negative = proc_signal_with_audittoken(&wrong, SIGUSR1);
  int negative_errno = errno;
  pid_t observed = waitpid(child, &status, WNOHANG);
  if (observed != 0) {
    // A completed wait releases identity; ECHILD likewise gives no ownership proof.
    if (observed == child || (observed < 0 && errno == ECHILD)) child = -1;
    result = 15;
    goto cleanup;
  }
  errno = 0;
  int positive = proc_signal_with_audittoken(&exact, SIGUSR1);
  int positive_errno = errno;
  if (waitpid(child, &status, 0) != child) {
    if (errno == ECHILD) child = -1;
    result = 16;
    goto cleanup;
  }
  child = -1; // positively reaped: never signal this numeric PID again
  printf("pid_version=%d mismatch_return=%d mismatch_errno=%d exact_return=%d exact_errno=%d exit_signal=%d\n",
         audit_token_to_pidversion(exact), negative, negative_errno, positive,
         positive_errno, WIFSIGNALED(status) ? WTERMSIG(status) : 0);
  if (negative != ESRCH || positive != 0 || !WIFSIGNALED(status) || WTERMSIG(status) != SIGUSR1)
    result = 17;
cleanup:
  close(pipefd[0]);
  if (child > 0) {
    // Direct waitable child retains its PID until this wait; no arbitrary PID signal.
    kill(child, SIGKILL);
    waitpid(child, &status, 0);
  }
  return result;
}
