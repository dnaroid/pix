// Offline test fixture: a maximally hostile owned-launch payload
// descendant. It ignores SIGTERM/SIGINT, escapes into its own session via
// setsid() (detached from the worker job's process group), records its pid
// for the harness, and dies only by its own bounded watchdog or by the
// supervisor's exact-generation audit-token SIGKILL. It never cooperates:
// it publishes nothing, catches nothing else, and execs nothing.
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc != 3) return 10;
  signal(SIGTERM, SIG_IGN);
  signal(SIGINT, SIG_IGN);
  if (setsid() == -1) return 11;
  FILE *f = fopen(argv[1], "w");
  if (!f) return 12;
  fprintf(f, "%d\n", getpid());
  fclose(f);
  long seconds = strtol(argv[2], NULL, 10);
  if (seconds <= 0) return 13;
  for (long i = 0; i < seconds; i++) sleep(1);
  return 0;
}
