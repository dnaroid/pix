// macOS-only offline discriminator. Q is the test binary; A is a detached
// provider-shaped child. K leaves A's group but remains in its session, and
// retains its own child Z as a waitable zombie in A's group after A is reaped.
// No PID read from a file is ever signaled. Q holds K's private owner-channel
// writer until after the probes; EOF (including Q death) makes K reap Z.
#include <sys/types.h>
#include <sys/wait.h>
#include <errno.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

struct topology { pid_t a, k, z, a_group, k_group, z_group, a_session, k_session, z_session; int first_pid, first_status; };
struct finish { int wait_result, wait_errno, wait_pid, wait_status, reap_result, reap_errno; pid_t k_group; };

static void expire(int unused) { (void)unused; _exit(97); }
static int wait_read(int fd, void *out, size_t size, int ms) {
    struct pollfd p = { .fd = fd, .events = POLLIN | POLLHUP };
    int r;
    do { r = poll(&p, 1, ms); } while (r < 0 && errno == EINTR);
    if (r <= 0) return -1;
    size_t got = 0;
    while (got < size) {
        ssize_t n = read(fd, (char *)out + got, size - got);
        if (n <= 0) return -1;
        got += (size_t)n;
    }
    return 0;
}
static int send_all(int fd, const void *data, size_t size) {
    const char *ptr = data;
    while (size) {
        ssize_t n = write(fd, ptr, size);
        if (n <= 0) return -1;
        ptr += n; size -= (size_t)n;
    }
    return 0;
}
static void probe(pid_t a) {
    errno = 0;
    int result = kill(-a, 0);
    int saved = errno;
    printf("probe signal0 signal=0 return=%d errno=%d\n", result, saved);
    fflush(stdout);
}
static void keeper(pid_t a, int output, int completion, int owner) {
    // K has its own process group but cannot create a new session: Z must be
    // allowed to join A's group. Q holds the sole owner-channel writer.
    if (setpgid(0, 0) != 0) _exit(91);
    alarm(18);
    int joined[2];
    if (pipe(joined) != 0) _exit(92);
    pid_t z = fork();
    if (z < 0) _exit(93);
    if (z == 0) {
        close(joined[0]); close(output); close(completion); close(owner);
        struct { pid_t group, session; int error; } ack = {0};
        ack.error = setpgid(0, a) == 0 ? 0 : errno;
        ack.group = getpgrp(); ack.session = getsid(0);
        (void)send_all(joined[1], &ack, sizeof ack);
        _exit(ack.error ? 94 : 7);
    }
    close(joined[1]);
    struct { pid_t group, session; int error; } ack;
    if (wait_read(joined[0], &ack, sizeof ack, 3000) != 0 || ack.error) {
        (void)waitpid(z, NULL, 0);
        _exit(95);
    }
    close(joined[0]);
    siginfo_t info = {0};
    if (waitid(P_PID, (id_t)z, &info, WEXITED | WNOWAIT) != 0 || info.si_pid != z) {
        (void)waitpid(z, NULL, 0);
        _exit(96);
    }
    struct topology t = { .a = a, .k = getpid(), .z = z, .a_group = a,
        .k_group = getpgrp(), .z_group = ack.group, .a_session = a,
        .k_session = getsid(0), .z_session = ack.session,
        .first_pid = info.si_pid, .first_status = info.si_status };
    if (send_all(output, &t, sizeof t) != 0) _exit(98);
    close(output);

    // The sole owner channel: release byte, EOF on Q death, or timeout.
    // On every path K still owns waitable Z and reaps it before exiting.
    struct pollfd p = { .fd = owner, .events = POLLIN | POLLHUP };
    int polled;
    do { polled = poll(&p, 1, 15000); } while (polled < 0 && errno == EINTR);
    if (polled > 0) { char release; (void)read(owner, &release, 1); }
    close(owner);
    struct finish f = {0};
    info = (siginfo_t){0}; errno = 0;
    f.wait_result = waitid(P_PID, (id_t)z, &info, WEXITED | WNOHANG | WNOWAIT);
    f.wait_errno = errno; f.wait_pid = info.si_pid; f.wait_status = info.si_status;
    f.k_group = getpgrp();
    errno = 0;
    f.reap_result = waitpid(z, NULL, 0);
    f.reap_errno = errno;
    (void)send_all(completion, &f, sizeof f);
    _exit(f.reap_result == z ? 0 : 99);
}
static void detached(int output, int completion, int owner) {
    alarm(6);
    if (setsid() != getpid()) _exit(90);
    int ready[2];
    if (pipe(ready) != 0) _exit(91);
    pid_t k = fork();
    if (k < 0) _exit(92);
    if (k == 0) { close(ready[0]); keeper(getppid(), ready[1], completion, owner); }
    close(ready[1]); close(completion); close(owner);
    struct topology t;
    if (wait_read(ready[0], &t, sizeof t, 3500) != 0) _exit(93);
    close(ready[0]);
    if (t.a != getpid() || t.k != k || t.a_group != getpgrp() || t.a_session != getsid(0)) _exit(94);
    if (send_all(output, &t, sizeof t) != 0) _exit(95);
    _exit(0);
}
int main(void) {
    struct sigaction action = {0};
    action.sa_handler = SIG_DFL;
    sigemptyset(&action.sa_mask);
    if (sigaction(SIGCHLD, &action, NULL) != 0) return 80;
    signal(SIGPIPE, SIG_IGN);
    signal(SIGALRM, expire);
    alarm(12);
    int ready[2], completion[2], owner[2];
    if (pipe(ready) != 0 || pipe(completion) != 0 || pipe(owner) != 0) return 81;
    pid_t a = fork();
    if (a < 0) return 82;
    if (a == 0) { close(ready[0]); close(completion[0]); close(owner[1]); detached(ready[1], completion[1], owner[0]); }
    close(ready[1]); close(completion[1]); close(owner[0]);
    struct topology t;
    if (wait_read(ready[0], &t, sizeof t, 4500) != 0) { close(owner[1]); (void)waitpid(a, NULL, 0); return 83; }
    close(ready[0]);
    int status = 0;
    if (waitpid(a, &status, 0) != a) { close(owner[1]); return 84; }
    printf("topology a=%d k=%d z=%d a_group=%d k_group=%d z_group=%d a_session=%d k_session=%d z_session=%d first_wait_pid=%d first_wait_status=%d\n",
        t.a, t.k, t.z, t.a_group, t.k_group, t.z_group, t.a_session, t.k_session, t.z_session, t.first_pid, t.first_status);
    printf("a_reaped=1 a_exit=%d k_alive=%d\n", WIFEXITED(status) ? WEXITSTATUS(status) : -1, kill(t.k, 0) == 0);
    fflush(stdout);
    // Never probe -A unless the captured same-session topology, waitable Z
    // proof, and positive A reap all succeeded. No positive PID is signaled.
    if (t.a != a || !WIFEXITED(status) || WEXITSTATUS(status) != 0 ||
        t.a_group != a || t.z_group != a || t.k_group != t.k || t.k == a ||
        t.a_session != a || t.k_session != a || t.z_session != a ||
        t.first_pid != t.z || t.first_status != 7 || kill(t.k, 0) != 0) {
        close(owner[1]); return 85;
    }
    // Only signal 0: K's watchdog can release Z independently, so the
    // captured number is not guaranteed to retain A's group identity.
    probe(a);
    printf("after_probe_k_alive=%d\n", kill(t.k, 0) == 0);
    fflush(stdout);
    // The runner's stdin is Q's release/EOF channel. K cannot reap Z until
    // Q has finished probing and forwards this release (or Q dies).
    struct pollfd p = { .fd = STDIN_FILENO, .events = POLLIN | POLLHUP };
    int polled;
    do { polled = poll(&p, 1, 5000); } while (polled < 0 && errno == EINTR);
    if (polled > 0) { char release; (void)read(STDIN_FILENO, &release, 1); }
    (void)send_all(owner[1], "r", 1);
    close(owner[1]);
    struct finish f;
    if (wait_read(completion[0], &f, sizeof f, 4500) != 0) return 86;
    // K is the sole remaining writer. EOF confirms its completion descriptor
    // closed after the second WNOWAIT and reap, not merely that Q got a packet.
    char leftover;
    ssize_t n;
    do { n = read(completion[0], &leftover, 1); } while (n < 0 && errno == EINTR);
    close(completion[0]);
    printf("z_second_wait_return=%d errno=%d pid=%d status=%d k_group=%d z_reap=%d reap_errno=%d\n",
        f.wait_result, f.wait_errno, f.wait_pid, f.wait_status, f.k_group, f.reap_result, f.reap_errno);
    printf("k_completion_eof=%d\n", n == 0);
    fflush(stdout);
    return n == 0 && f.wait_result == 0 && f.wait_pid == t.z && f.wait_status == 7 &&
        f.k_group == t.k && f.reap_result == t.z ? 0 : 87;
}
