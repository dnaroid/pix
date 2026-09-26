// macOS-only test: after A is positively reaped, K retains SID A but not PGID A.
// No destructive signal is sent to any stored PID or group. Watchdogs bound
// observation; they cannot guarantee durable identity for the captured PGID.
#include <sys/types.h>
#include <sys/wait.h>
#include <errno.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <unistd.h>

struct topology { pid_t a, k, a_group, k_group, k_session; };
struct completion { pid_t k, group, session; };

static void expire(int unused) { (void)unused; _exit(97); }
static int receive(int fd, void *buffer, size_t size, int timeout) {
    struct pollfd p = { .fd = fd, .events = POLLIN | POLLHUP };
    int result;
    do { result = poll(&p, 1, timeout); } while (result < 0 && errno == EINTR);
    if (result <= 0) return -1;
    size_t offset = 0;
    while (offset < size) {
        ssize_t n = read(fd, (char *)buffer + offset, size - offset);
        if (n <= 0) return -1;
        offset += (size_t)n;
    }
    return 0;
}
static int send_all(int fd, const void *buffer, size_t size) {
    const char *p = buffer;
    while (size) {
        ssize_t n = write(fd, p, size);
        if (n <= 0) return -1;
        p += n; size -= (size_t)n;
    }
    return 0;
}
static void keeper(pid_t a, int ready, int completed, int owner) {
    alarm(18);
    if (setpgid(0, 0) != 0) _exit(91);
    struct topology t = { a, getpid(), a, getpgrp(), getsid(0) };
    if (send_all(ready, &t, sizeof t) != 0) _exit(92);
    close(ready);
    // Only Q holds the writer; release, owner EOF, and watchdog all bound K.
    struct pollfd p = { .fd = owner, .events = POLLIN | POLLHUP };
    int result;
    do { result = poll(&p, 1, 15000); } while (result < 0 && errno == EINTR);
    if (result > 0) { char byte; (void)read(owner, &byte, 1); }
    close(owner);
    struct completion done = { getpid(), getpgrp(), getsid(0) };
    int sent = send_all(completed, &done, sizeof done);
    close(completed);
    _exit(sent == 0 ? 0 : 93);
}
static void anchor(int ready, int completed, int owner) {
    alarm(6);
    if (setsid() != getpid()) _exit(90);
    int from_k[2];
    if (pipe(from_k) != 0) _exit(91);
    pid_t a = getpid();
    pid_t k = fork();
    if (k < 0) _exit(92);
    if (k == 0) { close(from_k[0]); close(ready); keeper(a, from_k[1], completed, owner); }
    close(from_k[1]); close(completed); close(owner);
    struct topology t;
    if (receive(from_k[0], &t, sizeof t, 3500) != 0) _exit(93);
    close(from_k[0]);
    if (t.a != a || t.k != k || t.a_group != getpgrp() || t.k_group != k || t.k_session != a || getsid(0) != a) _exit(94);
    if (send_all(ready, &t, sizeof t) != 0) _exit(95);
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
    int ready[2], completed[2], owner[2];
    if (pipe(ready) != 0 || pipe(completed) != 0 || pipe(owner) != 0) return 81;
    pid_t a = fork();
    if (a < 0) return 82;
    if (a == 0) { close(ready[0]); close(completed[0]); close(owner[1]); anchor(ready[1], completed[1], owner[0]); }
    close(ready[1]); close(completed[1]); close(owner[0]);
    struct topology t;
    if (receive(ready[0], &t, sizeof t, 4500) != 0) { close(owner[1]); (void)waitpid(a, NULL, 0); return 83; }
    close(ready[0]);
    int status = 0;
    if (waitpid(a, &status, 0) != a) { close(owner[1]); return 84; }
    // Verify live K's session from the kernel, not just its earlier ACK.
    pid_t observed_session = getsid(t.k);
    printf("topology a=%d k=%d a_group=%d k_group=%d k_session=%d observed_k_session=%d\n",
        t.a, t.k, t.a_group, t.k_group, t.k_session, observed_session);
    printf("a_reaped=1 a_exit=%d\n", WIFEXITED(status) ? WEXITSTATUS(status) : -1);
    fflush(stdout);
    if (t.a != a || !WIFEXITED(status) || WEXITSTATUS(status) != 0 ||
        t.a_group != a || t.k_group != t.k || t.k == a || t.k_session != a || observed_session != a) {
        close(owner[1]); return 85;
    }
    errno = 0;
    int probe = kill(-a, 0); // The only kill call in this binary.
    int probe_errno = errno;
    printf("probe signal0 return=%d errno=%d\n", probe, probe_errno);
    fflush(stdout);
    // Q's stdin is a private release channel; early EOF is also released
    // only AFTER the probe. Q death closes K's owner channel directly.
    struct pollfd p = { .fd = STDIN_FILENO, .events = POLLIN | POLLHUP };
    int polled;
    do { polled = poll(&p, 1, 5000); } while (polled < 0 && errno == EINTR);
    if (polled > 0) { char byte; (void)read(STDIN_FILENO, &byte, 1); }
    (void)send_all(owner[1], "r", 1);
    close(owner[1]);
    struct completion done;
    if (receive(completed[0], &done, sizeof done, 4500) != 0) return 86;
    // A closed its copy; this EOF confirms K closed its descriptor AFTER its
    // completion report (Q exit or owner EOF alone would not confirm this).
    char extra;
    ssize_t n;
    do { n = read(completed[0], &extra, 1); } while (n < 0 && errno == EINTR);
    close(completed[0]);
    printf("keeper_completion k=%d group=%d session=%d eof=%d\n", done.k, done.group, done.session, n == 0);
    fflush(stdout);
    return probe == -1 && probe_errno == ESRCH && done.k == t.k &&
        done.group == t.k && done.session == a && n == 0 ? 0 : 87;
}
