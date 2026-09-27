// macOS-only test fixture. Unprivileged coalition_info(RESOURCE_USAGE)
// runtime accounting proof for an owned UUID launchd resource coalition.
//
// Modes:
//  - "leader": run as a temporary user-domain launchd job (unique UUID label,
//    RunAtLoad, no KeepAlive). Forks a NONCOOPERATIVE child that setsid()s and
//    execs the unmodified /bin/sleep (natural bounded expiry; after exec it
//    never writes, signals, or cooperates; pre-exec its only output is one
//    byte on a private CLOEXEC handshake pipe). A pipe handshake, not a
//    guessed sleep, proves the exec transition before publishing: the child
//    writes 'S' after setsid(), and a successful exec closes the write end
//    via FD_CLOEXEC, so 'S' then EOF is exec proof while 'E'/'X' bytes
//    report setsid/exec failure. Verifies the child inherited the leader's
//    resource coalition, publishes ids (including the child's p_uniqueid so
//    the probe can prove death by exact generation), then exits: the launchd
//    leader dies while the escaped setsid+exec descendant keeps the coalition
//    nonempty.
//  - "probe": run from OUTSIDE the coalition. Binds the leader's exact
//    instance (PROC_PIDUNIQIDENTIFIERINFO p_uniqueid) and waits for it to die
//    with no signals — death is observed only as ESRCH (no live task holds
//    the pid) or a known generation mismatch (p_uniqueid differs, pid
//    recycled); any other proc_pidinfo failure is NOT death evidence — then
//    binds the descendant identity via token-before/membership/token-after
//    (task_name_for_pid + TASK_AUDIT_TOKEN + PROC_PIDCOALITIONINFO,
//    generation-safe), reads flavor-1 counters (nonzero live count while the
//    descendant survives), issues the ONLY signal in this fixture
//    (exact-token SIGKILL after full verification), and polls to the
//    actual-zero read (tasks_started == tasks_exited with a successful
//    return, explicitly distinguished from ESRCH after reap). Descendant
//    death is confirmed only by precise generation evidence: an audit-token
//    mismatch, a p_uniqueid mismatch, or ESRCH — never by a bare
//    token-acquisition error.
//
// Host-verified private ABI. Host: macOS arm64, Darwin 23.6.0, kernel
// xnu-10063.141.1.712.16~1. The local source cache
// /tmp/g1-signal-source.LqKEhc is a main-branch XNU snapshot (xnu-11215-era,
// copyright 2000-2024): it is a same-family reference that agrees with this
// host's disassembly, NOT the exact shipping build, so every claim below is
// additionally re-verified at runtime on this host by the fixture's own
// diff oracle:
//  - nm -gU /usr/lib/system/libsystem_kernel.dylib exports
//    coalition_info_resource_usage (present on this host); otool shows it wraps
//    ___coalition_info (SYS_coalition_info 459) with flavor 1
//    (COALITION_INFO_RESOURCE_USAGE) as coalition_info_resource_usage(uint64_t
//    cid, void *buffer, size_t bufsize). Kernel coalition_info_resource_usage()
//    copyout()s MIN(bufsize, sizeof(struct coalition_resource_usage)); first
//    two u64 fields are tasks_started/tasks_exited. sys_coalition.c
//    coalition_info() has no privilege check ("TODO: priv check?") and returns
//    ESRCH only for unknown/reaped coalition ids.
//  - Empirical counter semantics on this host (snapshot instrumentation):
//    launchd's spawn of the job contributes one transient started+exited
//    pair (leader first observes started=2/exited=1, itself live), and every
//    exec transition adds +1 started and +1 exited (the pre-exec image counts
//    as exited). Totals are therefore host-kernel-specific; the oracle is the
//    DIFF: tasks_started - tasks_exited == live members (0 iff empty). The
//    test asserts the diff, records exact totals as evidence.
//  - PROC_PIDCOALITIONINFO / PROC_PIDUNIQIDENTIFIERINFO structs copied from
//    XNU bsd/sys/proc_info_private.h, same provenance as sibling fixtures
//    launchd-coalition-feasibility.c and audit-token-external-probe.c.
//
// Signal discipline: the probe never signals by PID (no kill, no signal 0, no
// SIGUSR1); only proc_signal_with_audittoken(exact, SIGKILL) after membership
// and generation verification. The leader may kill+reap only its own direct
// still-unreaped child on the internal-failure path (pid cannot be recycled
// while unreaped). Unverified targets are left to their natural bounded
// expiry (/bin/sleep N).
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

// Host library declaration (see header comment); no public SDK header exists.
extern int coalition_info_resource_usage(uint64_t cid, void *buffer, size_t bufsize);

// First fields of XNU struct coalition_resource_usage.
struct cru_head {
  uint64_t tasks_started;
  uint64_t tasks_exited;
  uint64_t time_nonempty;
  uint64_t cpu_time;
};

static int coalitions_of(pid_t pid, struct proc_pidcoalitioninfo *out) {
  memset(out, 0, sizeof(*out));
  return proc_pidinfo(pid, PROC_PIDCOALITIONINFO, 0, out, sizeof(*out)) == (int)sizeof(*out);
}

static int query_usage(uint64_t cid, struct cru_head *out, int *err) {
  memset(out, 0, sizeof(*out));
  errno = 0;
  int rc = coalition_info_resource_usage(cid, out, sizeof(*out));
  *err = errno;
  return rc;
}

// External kernel-issued identity (the target never cooperates).
static int acquire_token(pid_t pid, audit_token_t *token) {
  mach_port_name_t port = MACH_PORT_NULL;
  memset(token, 0, sizeof(*token));
  kern_return_t kr = task_name_for_pid(mach_task_self(), pid, &port);
  if (kr != KERN_SUCCESS || !MACH_PORT_VALID(port)) return -1;
  mach_msg_type_number_t count = TASK_AUDIT_TOKEN_COUNT;
  kr = task_info(port, TASK_AUDIT_TOKEN, (task_info_t)token, &count);
  mach_port_deallocate(mach_task_self(), port);
  if (kr != KERN_SUCCESS || count != TASK_AUDIT_TOKEN_COUNT) return -1;
  if (audit_token_to_pid(*token) != pid || audit_token_to_pidversion(*token) <= 0) return -1;
  return 0;
}

// Precise death evidence for the killed descendant's exact generation.
// Returns 1 = generation gone (audit-token mismatch on pid recycle,
// p_uniqueid mismatch, or ESRCH from PROC_PIDUNIQIDENTIFIERINFO meaning no
// live task holds the pid), 0 = same generation still present, -1 =
// indeterminate (retry). A bare token-acquisition error is NEVER death
// proof: it is cross-checked against the kernel's generation info first.
// (Host libproc quirk: proc_pidinfo fails with return 0, not -1, and errno
// set; ESRCH is the "no such live pid" case.)
static int generation_gone(pid_t pid, uint64_t uniqueid, const audit_token_t *ref) {
  audit_token_t cur;
  if (acquire_token(pid, &cur) == 0)
    return memcmp(&cur, ref, sizeof(cur)) == 0 ? 0 : 1;
  struct proc_uniqidentifierinfo ui;
  memset(&ui, 0, sizeof(ui));
  errno = 0;
  int n = proc_pidinfo(pid, PROC_PIDUNIQIDENTIFIERINFO, 0, &ui, sizeof(ui));
  int e = errno;
  if (n == (int)sizeof(ui)) return ui.p_uniqueid == uniqueid ? 0 : 1;
  if (n == 0 && e == ESRCH) return 1;
  return -1;
}

// EINTR-safe single-byte read: 1 = byte read, 0 = EOF, -1 = error.
static int read_handshake_byte(int fd, char *b) {
  for (;;) {
    ssize_t r = read(fd, b, 1);
    if (r == 1) return 1;
    if (r == 0) return 0;
    if (errno != EINTR) return -1;
  }
}

static int run_leader(long child_seconds) {
  alarm(10); // leader watchdog: publish and exit quickly
  struct proc_pidcoalitioninfo mine;
  if (!coalitions_of(getpid(), &mine) || mine.coalition_id[0] == 0) return 20;
  struct proc_uniqidentifierinfo uniq;
  memset(&uniq, 0, sizeof(uniq));
  if (proc_pidinfo(getpid(), PROC_PIDUNIQIDENTIFIERINFO, 0, &uniq, sizeof(uniq)) != (int)sizeof(uniq)) return 21;
  char secs[16];
  snprintf(secs, sizeof(secs), "%ld", child_seconds);
  // Exec barrier: CLOEXEC handshake pipe, not a guessed sleep. The child
  // writes 'S' once setsid() succeeded; a successful exec then closes its
  // write end via FD_CLOEXEC, so reading 'S' followed by EOF proves the exec
  // transition deterministically (a child death between 'S' and exec would
  // fake EOF, but the membership and uniqueid reads below would then fail
  // and contain). 'E'/'X' bytes report setsid/exec failure instead.
  int hs[2] = {-1, -1};
  if (pipe(hs) == -1) return 31;
  if (fcntl(hs[0], F_SETFD, FD_CLOEXEC) == -1 || fcntl(hs[1], F_SETFD, FD_CLOEXEC) == -1) {
    close(hs[0]);
    close(hs[1]);
    return 31;
  }
  pid_t child = fork();
  if (child < 0) {
    close(hs[0]);
    close(hs[1]);
    return 22;
  }
  if (!child) {
    // Noncooperative escaped descendant: new session, then unmodified
    // /bin/sleep with its own natural bounded expiry. Its only pre-exec
    // output is the private handshake byte; exec closes the pipe.
    close(hs[0]);
    char b = 'E';
    if (setsid() == -1) {
      if (write(hs[1], &b, 1) == 1) {}
      _exit(23);
    }
    b = 'S';
    if (write(hs[1], &b, 1) != 1) _exit(26);
    execl("/bin/sleep", "sleep", secs, (char *)0);
    b = 'X';
    if (write(hs[1], &b, 1) == 1) {}
    _exit(24);
  }
  close(hs[1]); // parent's copy must go, or EOF can never arrive
  char b1 = 0, b2 = 0;
  int r1 = read_handshake_byte(hs[0], &b1);
  int r2 = (r1 == 1 && b1 == 'S') ? read_handshake_byte(hs[0], &b2) : -1;
  close(hs[0]);
  if (r1 != 1 || b1 != 'S' || r2 != 0) {
    // Containment of our own direct still-unreaped child on internal failure.
    kill(child, SIGKILL);
    int st;
    while (waitpid(child, &st, 0) < 0 && errno == EINTR) {}
    return 29;
  }
  struct proc_pidcoalitioninfo theirs;
  if (!coalitions_of(child, &theirs) || theirs.coalition_id[0] != mine.coalition_id[0]) {
    // Containment of our own direct still-unreaped child on internal failure.
    kill(child, SIGKILL);
    int st;
    while (waitpid(child, &st, 0) < 0 && errno == EINTR) {}
    return 25;
  }
  // p_uniqueid is assigned at process creation and survives exec, so this is
  // the exec'd image's stable generation identity for the probe.
  struct proc_uniqidentifierinfo child_uniq;
  memset(&child_uniq, 0, sizeof(child_uniq));
  if (proc_pidinfo(child, PROC_PIDUNIQIDENTIFIERINFO, 0, &child_uniq, sizeof(child_uniq)) != (int)sizeof(child_uniq)) {
    kill(child, SIGKILL);
    int st;
    while (waitpid(child, &st, 0) < 0 && errno == EINTR) {}
    return 30;
  }
  printf("step=leader pid=%d resource=%llu jetsam=%llu child=%d leader_uniqueid=%llu child_uniqueid=%llu done=1\n",
         getpid(), (unsigned long long)mine.coalition_id[0], (unsigned long long)mine.coalition_id[1],
         child, (unsigned long long)uniq.p_uniqueid, (unsigned long long)child_uniq.p_uniqueid);
  return 0; // leader dies; launchd job stays exited (no KeepAlive)
}

static int run_probe(uint64_t cid, pid_t child, pid_t leader, uint64_t leader_uniqueid, uint64_t child_uniqueid) {
  alarm(30); // backstop; every poll below is independently bounded
  struct cru_head u;
  struct proc_pidcoalitioninfo own, member;
  uint64_t own_cid = 0, baseline_started = 0, baseline_exited = 0;
  uint64_t phase1_started = 0, phase1_exited = 0, phase2_started = 0, phase2_exited = 0;
  audit_token_t before, after;
  int e = 0, rc = 0, leader_dead = 0, kill_rc = 0, kill_errno = 0;
  int zero_read = 0, esrch_seen = 0, child_dead = 0, esrch_after = 0, polls = 0, token_bound = 0;
  int fail = 0;
  memset(&before, 0, sizeof(before));
  memset(&after, 0, sizeof(after));

  // (0) Host ABI sanity from outside the target coalition: id 0 must be ESRCH
  // (distinct from a real zero read); our own coalition must answer with a
  // live count, and must differ from the launchd job's coalition.
  rc = query_usage(0, &u, &e);
  if (rc != -1 || e != ESRCH) { fail = 30; goto verdict; }
  if (!coalitions_of(getpid(), &own) || own.coalition_id[0] == 0) { fail = 31; goto verdict; }
  own_cid = own.coalition_id[0];
  if (own_cid == cid) { fail = 32; goto verdict; } // probe must be outside the coalition
  rc = query_usage(own_cid, &u, &e);
  if (rc != 0 || u.tasks_started == 0 || u.tasks_started <= u.tasks_exited) { fail = 33; goto verdict; }
  baseline_started = u.tasks_started;
  baseline_exited = u.tasks_exited;

  // (1) Wait for the exact leader instance to die (unique id binding, no
  // signals). Only two observations count as death: ESRCH from
  // proc_pidinfo (no live task holds the pid anymore; host libproc signals
  // this as return 0 with errno ESRCH, not -1) or a known generation
  // mismatch (p_uniqueid differs: the pid was recycled to another instance).
  // Any other proc_pidinfo failure is NOT death evidence; it just retries
  // until the bounded loop expires and fails the probe.
  for (int i = 0; i < 500 && !leader_dead; i++) {
    struct proc_uniqidentifierinfo lu;
    errno = 0;
    int n = proc_pidinfo(leader, PROC_PIDUNIQIDENTIFIERINFO, 0, &lu, sizeof(lu));
    int e = errno;
    if (n == (int)sizeof(lu)) {
      if (lu.p_uniqueid != leader_uniqueid) leader_dead = 1; // pid recycled
    } else if (n == 0 && e == ESRCH) {
      leader_dead = 1; // exact live instance gone (zombies are not found here)
    }
    if (!leader_dead) usleep(10000);
  }
  if (!leader_dead) { fail = 34; goto verdict; }

  // (2) Generation-safe identity binding: token-before, membership, token-after.
  if (acquire_token(child, &before)) { fail = 35; goto verdict; }
  if (!coalitions_of(child, &member) || member.coalition_id[0] != cid) { fail = 36; goto verdict; }
  if (acquire_token(child, &after) || memcmp(&before, &after, sizeof(before)) != 0) { fail = 37; goto verdict; }
  token_bound = 1;

  // (3) Phase 1: leader dead, noncooperative setsid+exec descendant alive and
  // still a coalition member. Exact totals are host-specific (spawn/exec add
  // transient +1/+1 pairs on this host); the stable oracle is the live diff.
  rc = query_usage(cid, &u, &e);
  if (rc != 0) { fail = 38; goto verdict; } // must NOT be ESRCH while a member lives
  phase1_started = u.tasks_started;
  phase1_exited = u.tasks_exited;
  if (phase1_started < 2 || phase1_exited < 1 || phase1_started - phase1_exited != 1) { fail = 39; goto verdict; }

  // (4) The only signal issued: exact-token SIGKILL after verification.
  errno = 0;
  kill_rc = proc_signal_with_audittoken(&after, SIGKILL);
  kill_errno = errno;
  if (kill_rc != 0) { fail = 40; goto verdict; }

  // (5) Phase 2: poll to the actual-zero read; ESRCH here means reap raced
  // ahead and is recorded separately, never conflated with zero.
  for (int i = 0; i < 1200 && !zero_read && !esrch_seen; i++) {
    polls++;
    rc = query_usage(cid, &u, &e);
    if (rc == 0) {
      phase2_started = u.tasks_started;
      phase2_exited = u.tasks_exited;
      if (phase2_started == phase2_exited && phase2_started != 0) zero_read = 1;
    } else if (e == ESRCH) {
      esrch_seen = 1;
    }
    // Generation-precise observation only: a bare acquisition error is not
    // death (see generation_gone).
    if (generation_gone(child, child_uniqueid, &after) == 1) child_dead = 1;
    if (!zero_read && !esrch_seen) usleep(i < 200 ? 0 : 10000); // spin briefly to beat reap
  }
  if (!zero_read) { fail = 41; goto verdict; }
  // No member may join between the two reads: only exited catches up.
  if (phase2_started != phase1_started || phase2_exited != phase2_started) { fail = 42; goto verdict; }

  // Independent death confirmation: the exact generation is provably gone
  // (token/uniqueid mismatch or ESRCH). Indeterminate or alive readings
  // keep polling under the bounded loop; on expiry the probe fails.
  for (int i = 0; i < 300 && !child_dead; i++) {
    if (generation_gone(child, child_uniqueid, &after) == 1) child_dead = 1;
    else usleep(10000);
  }
  if (!child_dead) { fail = 43; goto verdict; }

  // (6) Informational, not asserted: does the coalition eventually reap to ESRCH?
  for (int i = 0; i < 500 && !esrch_after; i++) {
    rc = query_usage(cid, &u, &e);
    if (rc == -1 && e == ESRCH) esrch_after = 1;
    else usleep(10000);
  }

verdict:
  printf("summary=own_cid=%llu target_cid=%llu cid0=ESRCH baseline_started=%llu baseline_exited=%llu "
         "leader_dead=%d token_bound=%d member=1 kill_rc=%d kill_errno=%d phase1_started=%llu phase1_exited=%llu phase1_live=%lld "
         "phase2_started=%llu phase2_exited=%llu zero_read=%d esrch_seen=%d child_dead=%d esrch_after=%d polls=%d fail_code=%d\n",
         (unsigned long long)own_cid, (unsigned long long)cid,
         (unsigned long long)baseline_started, (unsigned long long)baseline_exited,
         leader_dead, token_bound, kill_rc, kill_errno,
         (unsigned long long)phase1_started, (unsigned long long)phase1_exited,
         (long long)(phase1_started - phase1_exited),
         (unsigned long long)phase2_started, (unsigned long long)phase2_exited,
         zero_read, esrch_seen, child_dead, esrch_after, polls, fail);
  return fail;
}

int main(int argc, char **argv) {
  setvbuf(stdout, NULL, _IONBF, 0);
  if (argc == 3 && strcmp(argv[1], "leader") == 0) {
    char *end = NULL;
    long secs = strtol(argv[2], &end, 10);
    if (end && *end == '\0' && secs > 0 && secs <= 120) return run_leader(secs);
    return 26;
  }
  if (argc == 7 && strcmp(argv[1], "probe") == 0) {
    char *end = NULL;
    unsigned long long cid = strtoull(argv[2], &end, 10);
    if (!end || *end != '\0') return 27;
    long c = strtol(argv[3], &end, 10), l = strtol(argv[4], &end, 10);
    if (!end || *end != '\0') return 27;
    unsigned long long lu = strtoull(argv[5], &end, 10);
    if (!end || *end != '\0') return 27;
    unsigned long long cu = strtoull(argv[6], &end, 10);
    if (!end || *end != '\0' || cid == 0 || c <= 0 || l <= 0 || lu == 0 || cu == 0) return 27;
    return run_probe(cid, (pid_t)c, (pid_t)l, lu, cu);
  }
  fprintf(stderr, "usage: %s leader <child-sleep-seconds> | probe <cid> <child-pid> <leader-pid> <leader-uniqueid> <child-uniqueid>\n", argv[0]);
  return 28;
}
