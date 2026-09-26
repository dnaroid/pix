// Test-only macOS relay. fd3: P liveness/cancel; fd4: cleanup receipt.
// A owns B until negative-B cleanup is complete. Never signal a recorded PID.
#include <sys/types.h>
#include <sys/wait.h>
#include <errno.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static volatile sig_atomic_t interrupted;
static void stop(int sig) { (void)sig; interrupted = 1; }
static void die_group(int sig) { (void)sig; kill(-getpgrp(), SIGKILL); _exit(98); }
static int put(int fd, const void *p, size_t n) {
    const char *bytes = p;
    while (n) { ssize_t count = write(fd, bytes, n); if (count < 0 && errno == EINTR) continue;
        if (count <= 0) return -1; bytes += count; n -= (size_t)count; }
    return 0;
}
static void group(int alive, int report, char **argv) {
    if (setpgid(0, 0)) _exit(98);
    signal(SIGPIPE, SIG_IGN);
    signal(SIGALRM, die_group);
    alarm(40); // independent fail-safe if A and its control channel misbehave
    pid_t c = fork();
    if (c < 0) { kill(-getpgrp(), SIGKILL); _exit(98); }
    if (!c) {
        struct sigaction action = {0}; action.sa_handler = SIG_DFL;
        sigemptyset(&action.sa_mask);
        if (sigaction(SIGCHLD, &action, NULL)) _exit(98);
        signal(SIGTERM, SIG_DFL); signal(SIGINT, SIG_DFL);
        signal(SIGALRM, SIG_DFL); signal(SIGPIPE, SIG_DFL);
        // No provider-private control/report/receipt writer or liveness reader in C.
        // Darwin's descriptor table limit, not an arbitrary low watermark.
        int limit = getdtablesize();
        for (int fd = 3; fd < limit; fd++) close(fd);
        execvp(argv[0], argv);
        _exit(127);
    }
    close(0); close(1); close(2);
    // Report only real waitpid status; meanwhile A EOF must self-kill this group.
    for (;;) {
        struct pollfd p = {.fd = alive, .events = POLLIN | POLLHUP};
        int n = poll(&p, 1, 10);
        if (n < 0 && errno != EINTR) { kill(-getpgrp(), SIGKILL); _exit(98); }
        if (n > 0 && (p.revents & (POLLHUP | POLLERR | POLLNVAL | POLLIN))) {
            char byte; ssize_t r = read(alive, &byte, 1);
            if (r <= 0) { kill(-getpgrp(), SIGKILL); _exit(99); }
        }
        int st; pid_t w = waitpid(c, &st, WNOHANG);
        if (w == c) {
            int code = WIFEXITED(st) ? WEXITSTATUS(st) : 128 + (WIFSIGNALED(st) ? WTERMSIG(st) : 0);
            if (put(report, &code, sizeof code)) { kill(-getpgrp(), SIGKILL); _exit(98); }
            close(report);
            // Retain B as A's direct child until A completes negative-B cleanup.
            for (;;) { char byte; ssize_t r = read(alive, &byte, 1);
                if (r <= 0) { kill(-getpgrp(), SIGKILL); _exit(99); } }
        }
        if (w < 0 && errno != EINTR) { kill(-getpgrp(), SIGKILL); _exit(98); }
    }
}
int main(int argc, char **argv) {
    if (argc < 2) return 98;
    struct sigaction action = {0}; action.sa_handler = SIG_DFL;
    sigemptyset(&action.sa_mask);
    if (sigaction(SIGCHLD, &action, NULL)) return 98;
    int alive[2], report[2];
    if (pipe(alive) || pipe(report)) return 98;
    pid_t b = fork(); if (b < 0) return 98;
    if (!b) {
        close(3); close(4); close(5); close(6); close(alive[1]); close(report[0]);
        group(alive[0], report[1], argv + 1); _exit(98);
    }
    close(alive[0]); close(report[1]);
    // B alone owns stdio passed to exec C. A must not prolong stdout EOF.
    close(0); close(1); close(2);
    action.sa_handler = stop;
    sigaction(SIGTERM, &action, NULL); sigaction(SIGINT, &action, NULL);
    int code = 90, got = 0, bad = 0, omit_receipt = 0, fault_cleanup = 0, hold = 0;
    for (;;) {
        if (interrupted) break;
        struct pollfd p[3] = {{.fd=3,.events=POLLIN | POLLHUP}, {.fd=got ? -1 : report[0],.events=POLLIN | POLLHUP},
            {.fd=5,.events=POLLIN}};
        int n = poll(p, 3, 100);
        if (n < 0 && errno == EINTR) continue;
        if (n < 0) { bad = 1; break; }
        if (p[0].revents & (POLLHUP | POLLERR | POLLNVAL | POLLIN)) {
            char byte; ssize_t r = read(3, &byte, 1);
            if (r <= 0) break;
        }
        // Private fixture-only fault checkpoint; B is still our unreaped direct
        // child, so this positive signal cannot target a recycled identity.
        if (p[2].revents & POLLIN) {
            char command; if (read(5, &command, 1) == 1) {
                if (command == 'K') { if (kill(b, SIGKILL) && errno != ESRCH) bad = 1; break; }
                if (command == 'R') { omit_receipt = 1; if (put(6, "R", 1)) bad = 1; }
                if (command == 'F') { fault_cleanup = 1; if (put(6, "F", 1)) bad = 1; }
                if (command == 'H') { hold = 1; if (put(6, "H", 1)) bad = 1; }
                if (command == 'U') break;
            }
        }
        if (p[1].revents & (POLLIN | POLLHUP | POLLERR | POLLNVAL)) {
            ssize_t r = read(report[0], &code, sizeof code);
            if (r == sizeof code) { got = 1; if (hold) { if (put(6, "S", 1)) bad = 1; continue; } break; }
            bad = 1; break;
        }
    }
    // Never release the B identity until after the negative signal. B may be
    // a zombie; waitpid is deliberately after group kill even on pre-ready loss.
    if (getpgrp() == b || (kill(-b, SIGKILL) && errno != ESRCH)) bad = 1;
    close(alive[1]);
    int st; pid_t w;
    do { w = waitpid(b, &st, 0); } while (w < 0 && errno == EINTR);
    if (w != b) bad = 1;
    // Inject only after real group cleanup. A's waitable child is the sole
    // target above; this fault cannot signal an arbitrary recorded PID.
    if (fault_cleanup) bad = 1;
    close(report[0]); close(3); close(5); close(6);
    int final = bad ? 98 : got ? code : 90;
    char receipt[32]; int size = snprintf(receipt, sizeof receipt, "%s:%d\n", bad ? "FAILED" : "CLEAN", final);
    if (size < 0 || size >= (int)sizeof receipt || (!omit_receipt && put(4, receipt, (size_t)size))) return 98;
    close(4);
    return final;
}
