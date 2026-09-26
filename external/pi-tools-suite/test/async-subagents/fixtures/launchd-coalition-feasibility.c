// Offline, one-shot launchd job. Private ABI copied verbatim from Apple XNU
// d8b80295118ef25ac3a784134bcf95cd8e88109f/bsd/sys/proc_info_private.h
// lines 65-70, 145-147 and osfmk/mach/coalition.h lines 78-82.
#include <libproc.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

#define PROC_PIDCOALITIONINFO 20
#define COALITION_NUM_TYPES 2
struct proc_pidcoalitioninfo {
  uint64_t coalition_id[COALITION_NUM_TYPES];
  uint64_t reserved1;
  uint64_t reserved2;
  uint64_t reserved3;
};
_Static_assert(sizeof(struct proc_pidcoalitioninfo) == 40, "XNU coalition ABI size");

static int report(const char *step) {
  struct proc_pidcoalitioninfo info = {0};
  int n = proc_pidinfo(getpid(), PROC_PIDCOALITIONINFO, 0, &info, sizeof(info));
  if (n != sizeof(info)) {
    printf("step=%s error=proc_pidinfo_return_%d\n", step, n);
    return 1;
  }
  printf("step=%s pid=%d resource=%llu jetsam=%llu\n", step, getpid(),
         (unsigned long long)info.coalition_id[0], (unsigned long long)info.coalition_id[1]);
  return 0;
}

int main(int argc, char **argv) {
  setvbuf(stdout, NULL, _IONBF, 0);
  alarm(7); // every exec descendant independently expires; no lingering job
  if (argc == 2 && strcmp(argv[1], "exec") == 0) return report("exec");
  if (argc != 1 || report("root")) return 10;
  pid_t child = fork();
  if (child < 0) return 11;
  if (!child) {
    alarm(5);
    if (report("fork") || setsid() == -1 || report("setsid")) _exit(12);
    execl(argv[0], argv[0], "exec", (char *)NULL);
    _exit(13);
  }
  int status;
  if (waitpid(child, &status, 0) != child || !WIFEXITED(status) || WEXITSTATUS(status)) return 14;
  puts("done=1");
  return 0;
}
