// macOS-only test fixture. External audit-token acquisition experiment.
// The forked child immediately execs the unmodified /bin/sleep and never
// publishes a token or cooperates; a close-on-exec pipe end only proves the
// exec itself happened. The parent obtains the kernel-issued token externally
// via the unprivileged task_name_for_pid + task_info(TASK_AUDIT_TOKEN) route
// described in https://developer.apple.com/forums/thread/652363 and implemented
// by the public endpoint-sec crate (audit.rs AuditToken::from_pid). XNU
// kern_proc.c task_name_for_pid permits same-euid+ruid callers for non-zombie
// targets; this is not the SIP-restricted task_for_pid path.
// Private ABI copied from Apple XNU bsd/sys/proc_info_private.h lines 40-51 and
// 145-147: struct proc_uniqidentifierinfo and PROC_PIDUNIQIDENTIFIERINFO.
// Never enumerate PIDs; only signal this fixture's own unreaped direct child.
#include <bsm/libbsm.h>
#include <errno.h>
#include <fcntl.h>
#include <libproc.h>
#include <mach/mach.h>
#include <mach/task_info.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

#define PROC_PIDUNIQIDENTIFIERINFO 17
struct proc_uniqidentifierinfo {
  uint8_t p_uuid[16];       /* UUID of the main executable */
  uint64_t p_uniqueid;      /* 64 bit unique identifier for process */
  uint64_t p_puniqueid;     /* unique identifier for process's parent */
  int32_t p_idversion;      /* pid version */
  int32_t p_orig_ppidversion;
  uint64_t p_reserve2;
  uint64_t p_reserve3;
};
_Static_assert(sizeof(struct proc_uniqidentifierinfo) == 56, "XNU uniq identifier ABI size");

int main(void) {
  alarm(15);
  int pipefd[2], status = 0, result = 0;
  pid_t child = -1;
  mach_port_name_t name_port = MACH_PORT_NULL;
  kern_return_t kr = KERN_FAILURE, dr = KERN_FAILURE;
  audit_token_t exact, wrong;
  memset(&exact, 0, sizeof(exact));
  memset(&wrong, 0, sizeof(wrong));
  struct proc_uniqidentifierinfo uniq, uniq_after;
  memset(&uniq, 0, sizeof(uniq));
  memset(&uniq_after, 0, sizeof(uniq_after));
  int negative = 0, negative_errno = 0, positive = 0, positive_errno = 0;
  int esrch = 0, un = 0, un_after = 0;
  pid_t observed = 0;

  if (pipe(pipefd)) return 10;
  if (fcntl(pipefd[1], F_SETFD, FD_CLOEXEC)) return 10;
  child = fork();
  if (child < 0) return 11;
  if (!child) {
    close(pipefd[0]);
    // Ordinary unmodified executable; the CLOEXEC write end closes at exec.
    execl("/bin/sleep", "sleep", "30", (char *)0);
    _exit(12);
  }
  close(pipefd[1]);
  for (;;) {
    char c;
    ssize_t n = read(pipefd[0], &c, 1);
    if (n == 0) break; // EOF: exec closed the child's write end
    if (n < 0 && errno == EINTR) continue;
    result = 13; // read error or unexpected data before EOF
    goto cleanup;
  }
  close(pipefd[0]);

  // External kernel-issued token; the child never sent us anything.
  kr = task_name_for_pid(mach_task_self(), child, &name_port);
  if (kr != KERN_SUCCESS || !MACH_PORT_VALID(name_port)) { result = 14; goto cleanup; }
  mach_msg_type_number_t count = TASK_AUDIT_TOKEN_COUNT;
  kr = task_info(name_port, TASK_AUDIT_TOKEN, (task_info_t)&exact, &count);
  dr = mach_port_deallocate(mach_task_self(), name_port); // release the Mach port
  name_port = MACH_PORT_NULL;
  if (kr != KERN_SUCCESS || count != TASK_AUDIT_TOKEN_COUNT || dr != KERN_SUCCESS ||
      audit_token_to_pid(exact) != child || audit_token_to_pidversion(exact) <= 0) { result = 15; goto cleanup; }

  // Alternative synthesis source: PROC_PIDUNIQIDENTIFIERINFO p_idversion is
  // filled by XNU proc_info.c as proc_pidversion(p), the same field the kernel
  // compares against token.val[7] in proc_find_audit_token.
  un = proc_pidinfo(child, PROC_PIDUNIQIDENTIFIERINFO, 0, &uniq, sizeof(uniq));
  if (un != (int)sizeof(uniq) || uniq.p_idversion != audit_token_to_pidversion(exact)) { result = 16; goto cleanup; }

  // Mutate only the PID generation slot; verify via Apple's public accessors.
  wrong = exact;
  wrong.val[7]++;
  if (audit_token_to_pid(wrong) != child ||
      audit_token_to_pidversion(wrong) == audit_token_to_pidversion(exact)) { result = 17; goto cleanup; }
  errno = 0;
  negative = proc_signal_with_audittoken(&wrong, SIGKILL);
  negative_errno = errno;
  esrch = (negative == ESRCH) || (negative == -1 && negative_errno == ESRCH);
  observed = waitpid(child, &status, WNOHANG);
  if (observed != 0) {
    // A completed wait releases identity; ECHILD likewise gives no ownership proof.
    if (observed == child || (observed < 0 && errno == ECHILD)) child = -1;
    result = 18;
    goto cleanup;
  }
  // Child survived the wrong-generation SIGKILL with identity unchanged.
  un_after = proc_pidinfo(child, PROC_PIDUNIQIDENTIFIERINFO, 0, &uniq_after, sizeof(uniq_after));
  if (!esrch || un_after != (int)sizeof(uniq_after) ||
      uniq_after.p_idversion != audit_token_to_pidversion(exact)) { result = 19; goto cleanup; }

  errno = 0;
  positive = proc_signal_with_audittoken(&exact, SIGKILL);
  positive_errno = errno;
  if (waitpid(child, &status, 0) != child) {
    if (errno == ECHILD) child = -1;
    result = 20;
    goto cleanup;
  }
  child = -1; // positively reaped: never signal this numeric PID again
  printf("pid_version=%d uniq_idversion=%d tnf=%d port_released=%d mismatch_return=%d mismatch_errno=%d exact_return=%d exact_errno=%d exit_signal=%d\n",
         (int)audit_token_to_pidversion(exact), (int)uniq.p_idversion, (int)kr, dr == KERN_SUCCESS,
         negative, negative_errno, positive, positive_errno, WIFSIGNALED(status) ? WTERMSIG(status) : 0);
  if (positive != 0 || positive_errno != 0 || !WIFSIGNALED(status) || WTERMSIG(status) != SIGKILL)
    result = 21;
cleanup:
  if (child > 0) {
    // Emergency cleanup of own still-unreaped direct child only; its PID cannot
    // be reused while unreaped. No other PID is ever signaled.
    kill(child, SIGKILL);
    waitpid(child, &status, 0);
  }
  if (MACH_PORT_VALID(name_port)) mach_port_deallocate(mach_task_self(), name_port);
  return result;
}
