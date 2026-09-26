// macOS offline topology experiment: A (relay) -> B (group sentinel) -> C + leaf.
// This is deliberately NOT a Pi/provider launcher or a general process-tree killer.
#include <sys/types.h>
#include <sys/wait.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static const char *dir;
static void record(const char *name, long value) {
    char path[1024];
    snprintf(path, sizeof path, "%s/%s", dir, name);
    FILE *f = fopen(path, "w");
    if (!f) _exit(98);
    fprintf(f, "%ld\n", value);
    fclose(f);
}
static int present(const char *name) {
    char path[1024];
    snprintf(path, sizeof path, "%s/%s", dir, name);
    return access(path, F_OK) == 0;
}
// Fixture-only backstops for running actors, not cleanup proof. An alarm cannot
// release SIGSTOP: checkpoints still require the harness's bounded finally path.
static void group_watchdog(int unused) {
    (void)unused;
    kill(-getpgrp(), SIGKILL);
    _exit(98);
}
static void leaf(void) {
    alarm(45);
    signal(SIGTERM, SIG_IGN);
    record("leaf", getpid());
    for (;;) pause();
}
static void cli(int code) {
    // Make C's policy for its own child D explicit too. B's inherited default
    // SIGCHLD policy, set in A before fork, is what makes C waitable by B.
    struct sigaction child_action = {0};
    child_action.sa_handler = SIG_DFL;
    sigemptyset(&child_action.sa_mask);
    if (sigaction(SIGCHLD, &child_action, NULL) != 0) _exit(98);
    alarm(45);
    pid_t d = fork();
    if (d < 0) _exit(98);
    if (d == 0) leaf();
    record("cli", getpid());
    while (!present("complete")) usleep(10000);
    _exit(code);
}
static void sentinel(int alive, int report, int code) {
    if (setpgid(0, 0) != 0) _exit(98);
    signal(SIGALRM, group_watchdog);
    alarm(45);
    // A can die between a liveness poll and a status write: EPIPE must not
    // terminate B before it kills the group on the next liveness observation.
    signal(SIGPIPE, SIG_IGN);
    record("b", getpid());
    pid_t c = fork();
    if (c < 0) _exit(98);
    if (c == 0) {
        close(alive); close(report);
        signal(SIGALRM, SIG_DFL);
        cli(code);
    }
    // B is the only reader of A's private liveness pipe. C and D cannot hold it.
    int sent = 0;
    for (;;) {
        struct pollfd p = { .fd = alive, .events = POLLIN | POLLHUP };
        int n = poll(&p, 1, 10);
        if (n > 0 && (p.revents & (POLLHUP | POLLIN))) {
            char byte;
            if (read(alive, &byte, 1) == 0) {
                record("b_eof", 1);
                kill(-getpgrp(), SIGKILL);
                _exit(99);
            }
        }
        if (n < 0 && errno != EINTR) _exit(98);
        if (!sent) {
            int st;
            pid_t result = waitpid(c, &st, WNOHANG);
            if (result == c) {
                int actual = WIFEXITED(st) ? WEXITSTATUS(st) : 128;
                // One atomic status write; closing report signals no other status is coming.
                if (write(report, &actual, sizeof actual) != sizeof actual) {
                    kill(-getpgrp(), SIGKILL);
                    _exit(98);
                }
                close(report);
                sent = 1;
            } else if (result < 0 && errno != EINTR) _exit(98);
        }
    }
}
int main(int argc, char **argv) {
    if (argc != 4) return 98;
    dir = argv[1];
    int code = atoi(argv[2]);
    if (code != 0 && code != 7) return 98;
    int race = strcmp(argv[3], "race") == 0;
    int startup = strcmp(argv[3], "startup") == 0;
    if (!race && !startup && strcmp(argv[3], "normal") != 0) return 98;
    // The direct-child anchor requires B to remain waitable even if this
    // fixture was launched by a process with a nondefault SIGCHLD policy.
    struct sigaction child_action = {0};
    child_action.sa_handler = SIG_DFL;
    sigemptyset(&child_action.sa_mask);
    if (sigaction(SIGCHLD, &child_action, NULL) != 0) return 98;
    alarm(45);
    int alive[2], report[2];
    if (pipe(alive) || pipe(report)) return 98;
    pid_t b = fork();
    if (b < 0) return 98;
    if (b == 0) {
        close(alive[1]); close(report[0]);
        sentinel(alive[0], report[1], code);
        _exit(98);
    }
    close(alive[0]); close(report[1]);
    record("a", getpid());
    // Stop before the first getpgid observation, not after group ownership is
    // verified. B can establish its group and launch C/D while A is stopped.
    if (startup) {
        record("pre_ready_checkpoint", b);
        raise(SIGSTOP);
    }
    // A retains B as a direct, waitable child until AFTER negative-group cleanup.
    // A never joins B's group. The ready marker is set only on confirmed topology.
    for (int i = 0; i < 500 && getpgid(b) != b; ++i) usleep(1000);
    siginfo_t startup_info;
    memset(&startup_info, 0, sizeof startup_info);
    int startup_wait = waitid(P_PID, (id_t)b, &startup_info, WEXITED | WNOHANG | WNOWAIT);
    if (getpgid(b) != b || getpgrp() == b || startup_wait != 0 || startup_info.si_pid == b) {
        // B remains our unreaped direct child, anchoring the numeric PGID even
        // if it is already a zombie. Never signal the positive PID. ESRCH is
        // expected if B has not formed a group yet: close the sole liveness
        // writer so a still-running B kills its own group upon EOF.
        if (getpgrp() != b) kill(-b, SIGKILL);
        close(alive[1]); close(report[0]);
        pid_t reaped;
        do { reaped = waitpid(b, NULL, 0); } while (reaped < 0 && errno == EINTR);
        if (reaped != b) return 98;
        record("b_reaped", 1);
        return 98;
    }
    record("ready", b);
    int actual = -1;
    ssize_t count;
    do { count = read(report[0], &actual, sizeof actual); } while (count < 0 && errno == EINTR);
    // Test-only checkpoint after real C status, before any cleanup. Kernel SIGSTOP
    // permits the test to kill B in this otherwise narrow callback gap.
    if (count == sizeof actual && race) {
        record("checkpoint", actual);
        raise(SIGSTOP);
    }
    siginfo_t info;
    memset(&info, 0, sizeof info);
    int observed = waitid(P_PID, (id_t)b, &info, WEXITED | WNOHANG | WNOWAIT);
    if (observed == 0 && info.si_pid == b) record("zombie_wnowait", info.si_status);
    // B remains a child (including as a zombie) and anchors the group identity.
    // Do not close the liveness writer until cleanup is attempted.
    if (kill(-b, SIGKILL) != 0 && errno != ESRCH) actual = -1;
    int status;
    pid_t reaped;
    do { reaped = waitpid(b, &status, 0); } while (reaped < 0 && errno == EINTR);
    if (reaped != b) return 98;
    record("b_reaped", 1);
    close(alive[1]); close(report[0]);
    return count == sizeof actual && (actual == 0 || actual == 7) ? actual : 90;
}
