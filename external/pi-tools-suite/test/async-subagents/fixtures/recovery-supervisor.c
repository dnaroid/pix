// macOS-only offline fixture: independent recovery supervisor, run as a
// temporary UUID-labelled one-shot launchd job in the gui domain. It is a
// child of launchd, not of the app/helper lineage, so it survives joint
// application/helper loss (that survival is structural: launchd bootstrapped
// it independently, not automatic descendant cleanup).
//
// Restart experiment: invoked with an optional generation argument (for
// example "a" or "b"), the job uses generation-suffixed artifact names
// (r-<gen>.json, gate-<gen>, receipt-<gen>.json, owner-loss-<gen>) so a fresh
// generation can be launched while a previous one's artifacts remain on disk.
// After confirming owner loss it writes the owner-loss marker and parks on its
// gate. The restart test never opens the killed generation's gate. A gate
// timeout writes a failure receipt in both modes; alarm(15) bounds the job.
// Legacy two-argument invocation keeps the original unsuffixed names.
//
// Post-kill/pre-receipt experiment: two further explicit modes are required;
// neither changes the legacy or plain generation contracts above.
//   supervisor <dir> <gen> kill-then-park
//     After owner loss and its gate, R1 probes the authentic leaf token,
//     SIGKILLs it, confirms ESRCH, and only then writes an atomic
//     postkill-<gen>.json checkpoint naming the exact killed actor
//     (token/PID/PID-version), its generation, and the observed kill result.
//     It then parks on receipt-gate-<gen> BEFORE any receipt, so a supervisor
//     killed while parked leaves a durable kill record but no receipt.
//   supervisor <dir> <gen> already-absent <kill-gen>
//     R2 rebuilds A/B/C from the persisted pre-loss checkpoints, confirms
//     A/B ESRCH, then loads and strictly validates postkill-<kill-gen>.json
//     (parse, internal token/PID/PID-version consistency, recorded successful
//     kill and confirmed-gone result, generation match, and cross-check of
//     token/PID/PID-version/deadline against leaf.json). Only after full
//     validation does it probe the leaf token and require ESRCH; this mode
//     NEVER sends SIGKILL (kill_attempted=0, kill_return=-2 in its receipt).
//     Missing, unparseable, mismatched, contradicted, or still-alive targets
//     fail closed with a failure receipt.
//
// Kill-to-checkpoint-window experiment: two more explicit modes; the modes
// above (including the strict already-absent missing-record failure) retain
// their behavior.
//   supervisor <dir> <gen> kill-park-precheck
//     Identical to kill-then-park through the exact-token SIGKILL and its
//     ESRCH confirmation, then writes a precheck-<gen> marker and parks on a
//     NEW checkpoint-gate-<gen> BEFORE writing the postkill checkpoint. The
//     harness never opens that gate, so a supervisor killed while parked
//     leaves neither a kill record nor a receipt: this is the deterministic
//     test-only park point inside the kill-to-checkpoint window.
//   supervisor <dir> <gen> already-absent-unknown <kill-gen>
//     Present postkill-<kill-gen>.json records go through exactly the strict
//     already-absent validation above (every loader failure reason unchanged;
//     a present-but-invalid record fails closed even when the target is
//     actually gone). Presence itself is classified without following
//     symlinks: lstat, so a dangling postkill-<kill-gen>.json symlink is a
//     PRESENT nonregular entry (fail-closed reason "not-regular"), never a
//     missing one that a following access(F_OK) probe would misread as
//     ENOENT. Only a genuinely ENOENT-absent record may take the
//     cause-unknown path: R2 cross-checks A/B ESRCH as always, then runs its
//     own bounded exact-token absence probe (~3s). ESRCH yields a distinct
//     ok receipt stage=already-absent reason=cause-unknown
//     postkill_record=absent kill_attempted=0 kill_return=-2 — the restart
//     may honestly conclude "already absent, cause unknown", never kill
//     success or attribution. A live or timing-out target fails
//     target-alive/not-absent; an unexpected probe return fails closed. This
//     mode never signals SIGKILL either. No pre-kill intent record exists:
//     intent would prove nothing R2 may consume.
//
// Claim boundary: the legacy modes prove restart recovery only when the first
// owner crashed AFTER its confirmed kill checkpoint was published; the
// kill-park-precheck/already-absent-unknown pair proves the bounded
// process-crash case inside the kill-to-checkpoint window, where the restart
// re-proves absence itself and reports cause-unknown. Neither covers power
// loss (no fsync proof across power failure) or reboot, and the unknown path
// never feeds a kill-verified claim.
//
// Stated limitation: it can only recover actors that publish their own
// kernel-issued audit token to a checkpoint file. All signaling goes through
// proc_signal_with_audittoken after validating the recorded PID/PID-version
// pair via Apple's libbsm accessors; liveness probes use SIGUSR1, ignored by
// the cooperating actors (signum 0 is rejected EINVAL on this host). No saved
// PID kills, no process-group kills, no PID enumeration. Every wait is
// bounded; a failure receipt names the stage and the alarm(15) is the last
// resort so no lingering job survives.
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
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#include "recovery-postkill-record.h"

typedef struct {
  pid_t pid;
  int pidversion;
  audit_token_t token;
  long start;
  long deadline;
} actor_t;

static const char *g_dir;
static const char *g_gen = "";
static char g_r_name[64], g_gate_name[64], g_receipt_name[64], g_marker_name[64],
            g_postkill_name[64], g_receipt_gate_name[64], g_precheck_name[64],
            g_checkpoint_gate_name[64];

static int valid_gen(const char *g) {
  size_t n = strlen(g);
  if (n == 0 || n > 16) return 0;
  for (size_t i = 0; i < n; i++) {
    char c = g[i];
    if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9'))) return 0;
  }
  return 1;
}

static int make_names(void) {
  const char *stems[] = { "r", "gate", "receipt", "owner-loss", "postkill", "receipt-gate", "precheck", "checkpoint-gate" };
  const char *exts[] = { ".json", "", ".json", "", ".json", "", "", "" };
  char *outs[] = { g_r_name, g_gate_name, g_receipt_name, g_marker_name, g_postkill_name, g_receipt_gate_name, g_precheck_name, g_checkpoint_gate_name };
  for (size_t i = 0; i < sizeof(stems) / sizeof(stems[0]); i++) {
    int n = snprintf(outs[i], 64, "%s%s%s", stems[i], g_gen, exts[i]);
    if (n <= 0 || n >= 64) return -1;
  }
  return 0;
}

// Atomic publication primitive shared with the postkill record contract in
// recovery-postkill-record.h (tmp file + fsync + rename).
int recovery_write_atomic(const char *path, const char *buf, size_t len) {
  char tmp[4096];
  if ((size_t)snprintf(tmp, sizeof(tmp), "%s.tmp", path) >= sizeof(tmp)) return -1;
  int fd = open(tmp, O_WRONLY | O_CREAT | O_TRUNC, 0644);
  if (fd < 0) return -1;
  size_t off = 0;
  while (off < len) {
    ssize_t k = write(fd, buf + off, len - off);
    if (k <= 0) { close(fd); return -1; }
    off += (size_t)k;
  }
  if (fsync(fd)) { close(fd); return -1; }
  if (close(fd)) return -1;
  return rename(tmp, path);
}

static void publish_self(long backstop_seconds) {
  audit_token_t token;
  mach_msg_type_number_t count = TASK_AUDIT_TOKEN_COUNT;
  if (task_info(mach_task_self(), TASK_AUDIT_TOKEN, (task_info_t)&token, &count) != KERN_SUCCESS ||
      count != TASK_AUDIT_TOKEN_COUNT) _exit(20);
  char path[4096], buf[512];
  long now = time(NULL);
  if ((size_t)snprintf(path, sizeof(path), "%s/%s", g_dir, g_r_name) >= sizeof(path)) _exit(21);
  int n = snprintf(buf, sizeof(buf),
      "role=supervisor pid=%d pidversion=%d "
      "token=%08x%08x%08x%08x%08x%08x%08x%08x start=%ld deadline=%ld\n",
      getpid(), audit_token_to_pidversion(token),
      token.val[0], token.val[1], token.val[2], token.val[3],
      token.val[4], token.val[5], token.val[6], token.val[7],
      now, now + backstop_seconds);
  if (n <= 0 || (size_t)n >= sizeof(buf) || recovery_write_atomic(path, buf, (size_t)n)) _exit(22);
}

static void sleep_ms(long ms) {
  struct timespec ts = { ms / 1000, (ms % 1000) * 1000000L };
  nanosleep(&ts, NULL);
}

static int wait_file(const char *name, long seconds) {
  char path[4096];
  if ((size_t)snprintf(path, sizeof(path), "%s/%s", g_dir, name) >= sizeof(path)) return -1;
  struct timespec start, now;
  clock_gettime(CLOCK_MONOTONIC, &start);
  for (;;) {
    if (access(path, R_OK) == 0) return 0;
    clock_gettime(CLOCK_MONOTONIC, &now);
    if (now.tv_sec - start.tv_sec >= seconds) return -1;
    sleep_ms(20);
  }
}

static int load_actor(const char *role, actor_t *a) {
  char path[4096], line[512], seen_role[32];
  if ((size_t)snprintf(path, sizeof(path), "%s/%s.json", g_dir, role) >= sizeof(path)) return -1;
  FILE *f = fopen(path, "r");
  if (!f) return -1;
  if (!fgets(line, sizeof(line), f)) { fclose(f); return -1; }
  fclose(f);
  unsigned int v[8];
  int n = sscanf(line,
      "role=%31s pid=%d pidversion=%d token=%8x%8x%8x%8x%8x%8x%8x%8x start=%ld deadline=%ld",
      seen_role, &a->pid, &a->pidversion, &v[0], &v[1], &v[2], &v[3],
      &v[4], &v[5], &v[6], &v[7], &a->start, &a->deadline);
  if (n != 13 || strcmp(seen_role, role) != 0) return -1;
  for (int i = 0; i < 8; i++) a->token.val[i] = v[i];
  // The token itself must identify the recorded PID and PID-version.
  if (audit_token_to_pid(a->token) != a->pid ||
      audit_token_to_pidversion(a->token) != a->pidversion) return -1;
  return 0;
}

// Liveness probing uses SIGUSR1, which the cooperating actors ignore, because
// proc_signal_with_audittoken rejects signum 0 with EINVAL on this host. The
// lookup itself is still generation-safe: a stale PID-version returns ESRCH
// before any delivery decision, so a reused PID is never mistaken for the
// recorded actor.
static int probe(const audit_token_t *t, int sig, int *err) {
  errno = 0;
  int r = proc_signal_with_audittoken((audit_token_t *)t, sig);
  if (err) *err = errno;
  return r;
}

// 1 = exact generation gone (ESRCH), 0 = still alive at deadline, -1 = unexpected.
static int wait_gone(const audit_token_t *t, long seconds, int *last_return, int *last_errno) {
  struct timespec start, now;
  clock_gettime(CLOCK_MONOTONIC, &start);
  for (;;) {
    *last_return = probe(t, SIGUSR1, last_errno);
    if (*last_return == ESRCH) return 1;
    if (*last_return != 0) return -1;
    clock_gettime(CLOCK_MONOTONIC, &now);
    if (now.tv_sec - start.tv_sec >= seconds) return 0;
    sleep_ms(20);
  }
}

static int write_receipt(const char *status, const char *stage, int owner_r, int owner_e,
    int helper_r, int helper_e, int alive_before_kill, int alive_errno,
    int kill_return, int kill_errno, int gone, int gone_errno, long recovered_at,
    long leaf_deadline, pid_t leaf_pid) {
  char path[4096], buf[1024];
  if ((size_t)snprintf(path, sizeof(path), "%s/%s", g_dir, g_receipt_name) >= sizeof(path)) return -1;
  int n = snprintf(buf, sizeof(buf),
      "status=%s stage=%s owner_probe=%d owner_errno=%d helper_probe=%d helper_errno=%d "
      "alive_before_kill=%d alive_errno=%d kill_return=%d kill_errno=%d gone=%d gone_errno=%d "
      "recovered_at=%ld leaf_deadline=%ld leaf_pid=%d\n",
      status, stage, owner_r, owner_e, helper_r, helper_e,
      alive_before_kill, alive_errno, kill_return, kill_errno, gone, gone_errno,
      recovered_at, leaf_deadline, leaf_pid);
  if (n <= 0 || (size_t)n >= sizeof(buf)) return -1;
  return recovery_write_atomic(path, buf, (size_t)n);
}

// The published postkill record itself (postkill_t, strict loader, writer)
// lives in recovery-postkill-record.h so its format and identity rules have
// one owner shared by every restart mode.

// Receipt for the already-absent and already-absent-unknown modes. kill_return
// is fixed at the NOT_ATTEMPTED sentinel -2: neither mode ever sends SIGKILL;
// a target that is not ESRCH-absent after validation fails closed. A NULL
// postkill_record keeps the legacy already-absent receipt byte-identical; the
// unknown mode passes "absent" (genuine ENOENT record) or "present"
// (record existed and failed strict validation) so consumers can never
// conflate a cause-unknown conclusion with the checkpoint-confirmed path.
static int write_absent_receipt(const char *status, const char *stage, const char *reason,
    int owner_r, int owner_e, int helper_r, int helper_e,
    int absent_probe, int absent_errno, const char *postkill_gen,
    const char *postkill_record,
    long recovered_at, long leaf_deadline, pid_t leaf_pid) {
  char path[4096], buf[1024];
  if ((size_t)snprintf(path, sizeof(path), "%s/%s", g_dir, g_receipt_name) >= sizeof(path)) return -1;
  int n;
  if (postkill_record) {
    n = snprintf(buf, sizeof(buf),
        "status=%s stage=%s reason=%s owner_probe=%d owner_errno=%d helper_probe=%d helper_errno=%d "
        "absent_probe=%d absent_errno=%d kill_attempted=0 kill_return=-2 kill_errno=0 "
        "postkill_gen=%s postkill_record=%s recovered_at=%ld leaf_deadline=%ld leaf_pid=%d\n",
        status, stage, reason, owner_r, owner_e, helper_r, helper_e,
        absent_probe, absent_errno, postkill_gen, postkill_record,
        recovered_at, leaf_deadline, leaf_pid);
  } else {
    n = snprintf(buf, sizeof(buf),
        "status=%s stage=%s reason=%s owner_probe=%d owner_errno=%d helper_probe=%d helper_errno=%d "
        "absent_probe=%d absent_errno=%d kill_attempted=0 kill_return=-2 kill_errno=0 "
        "postkill_gen=%s recovered_at=%ld leaf_deadline=%ld leaf_pid=%d\n",
        status, stage, reason, owner_r, owner_e, helper_r, helper_e,
        absent_probe, absent_errno, postkill_gen, recovered_at, leaf_deadline, leaf_pid);
  }
  if (n <= 0 || (size_t)n >= sizeof(buf)) return -1;
  return recovery_write_atomic(path, buf, (size_t)n);
}

enum { MODE_RECOVER, MODE_KILL_THEN_PARK, MODE_KILL_PARK_PRECHECK,
       MODE_ALREADY_ABSENT, MODE_ALREADY_ABSENT_UNKNOWN };

int main(int argc, char **argv) {
  setvbuf(stdout, NULL, _IONBF, 0);
  alarm(15);
  if (argc != 2 && argc != 3 && argc != 4 && argc != 5) return 10;
  int mode = MODE_RECOVER;
  const char *kill_gen = NULL;
  static char gen_buf[24];
  if (argc >= 3) {
    if (!valid_gen(argv[2])) return 10;
    int n = snprintf(gen_buf, sizeof(gen_buf), "-%s", argv[2]);
    if (n <= 0 || (size_t)n >= sizeof(gen_buf)) return 10;
    g_gen = gen_buf;
  }
  if (argc >= 4) {
    if (argc == 4 && strcmp(argv[3], "kill-then-park") == 0) {
      mode = MODE_KILL_THEN_PARK;
    } else if (argc == 4 && strcmp(argv[3], "kill-park-precheck") == 0) {
      mode = MODE_KILL_PARK_PRECHECK;
    } else if (argc == 5 && strcmp(argv[3], "already-absent") == 0 && valid_gen(argv[4])) {
      mode = MODE_ALREADY_ABSENT;
      kill_gen = argv[4];
    } else if (argc == 5 && strcmp(argv[3], "already-absent-unknown") == 0 && valid_gen(argv[4])) {
      mode = MODE_ALREADY_ABSENT_UNKNOWN;
      kill_gen = argv[4];
    } else {
      return 10;
    }
  }
  g_dir = argv[1];
  if (make_names()) return 10;
  publish_self(15);

  actor_t app = {0}, helper = {0}, leaf = {0};
  int waited = 0;
  while (load_actor("app", &app) || load_actor("helper", &helper) || load_actor("leaf", &leaf)) {
    if (waited >= 8000) {
      write_receipt("fail", "checkpoints", 0, 0, 0, 0, 0, 0, 0, 0,
                    0, 0, time(NULL), 0, -1);
      return 1;
    }
    sleep_ms(20);
    waited += 20;
  }

  // Owner-loss detection is generation-safe: SIGUSR1 probes (ignored by the
  // cooperating actors) of each recorded audit token, never a signal to a
  // saved PID. A reused PID would carry a new PID-version and correctly stay
  // unreported.
  int owner_r = 0, owner_e = 0, helper_r = 0, helper_e = 0;
  int owner_gone = wait_gone(&app.token, 6, &owner_r, &owner_e);
  int helper_gone = wait_gone(&helper.token, 6, &helper_r, &helper_e);
  if (owner_gone != 1 || helper_gone != 1) {
    write_receipt("fail", "owner-loss", owner_r, owner_e, helper_r, helper_e,
                  0, 0, 0, 0, 0, 0, time(NULL), leaf.deadline, leaf.pid);
    return 1;
  }

  // Publish the gate-park marker, then park until the harness opens this
  // generation's gate. The restart experiment never opens the killed
  // generation's gate and removes that job while it waits here, so the marker
  // is the harness's deterministic "pre-cleanup" observation point.
  char marker_path[4096];
  if ((size_t)snprintf(marker_path, sizeof(marker_path), "%s/%s", g_dir, g_marker_name) >= sizeof(marker_path) ||
      recovery_write_atomic(marker_path, "stage=gate-wait\n", strlen("stage=gate-wait\n"))) {
    write_receipt("fail", "marker", owner_r, owner_e, helper_r, helper_e,
                  0, 0, 0, 0, 0, 0, time(NULL), leaf.deadline, leaf.pid);
    return 1;
  }

  // Gate: the harness drops this marker once it has observed the survivors, so
  // the survival demonstration is ordered before recovery.
  if (wait_file(g_gate_name, 8)) {
    write_receipt("fail", "gate", owner_r, owner_e, helper_r, helper_e,
                  0, 0, 0, 0, 0, 0, time(NULL), leaf.deadline, leaf.pid);
    return 1;
  }

  // Only authentic recorded tokens are safe here: C is no longer our waitable
  // child. A fabricated future generation could match a reused PID if C died.
  // The separate direct-waitable-child feasibility test owns that negative test.
  int alive_errno = 0;
  int kill_errno = 0;
  int gone_r = 0, gone_e = 0;

  if (mode == MODE_ALREADY_ABSENT || mode == MODE_ALREADY_ABSENT_UNKNOWN) {
    // Load and strictly validate the first owner's postkill checkpoint before
    // any conclusion. Validation failures fail closed with kill_attempted=0.
    char pk_name[40], pk_path[4096];
    postkill_t pk;
    const char *reason = NULL;
    int unknown_mode = (mode == MODE_ALREADY_ABSENT_UNKNOWN);
    // Only the unknown mode may branch on a genuinely ENOENT-absent record.
    // A present record always goes through the same strict validation as the
    // legacy mode. Presence is classified with lstat so the classification
    // never follows a symlink: a dangling postkill-<kill-gen>.json symlink is
    // a present entry that access(F_OK) would have followed into ENOENT and
    // misclassified as missing. Any nonregular entry (symlink, directory,
    // fifo, ...) is rejected explicitly as present with reason "not-regular",
    // and any non-ENOENT lookup error fails closed as well.
    int record_present = 1;
    if ((size_t)snprintf(pk_name, sizeof(pk_name), "postkill-%s.json", kill_gen) >= sizeof(pk_name) ||
        (size_t)snprintf(pk_path, sizeof(pk_path), "%s/%s", g_dir, pk_name) >= sizeof(pk_path)) {
      reason = "path-overflow";
    } else if (unknown_mode) {
      struct stat st;
      if (lstat(pk_path, &st) == 0) {
        record_present = 1;
        if (!S_ISREG(st.st_mode)) reason = "not-regular";
      } else if (errno == ENOENT) {
        record_present = 0;
      } else {
        reason = "unreadable";
      }
    }
    if (!reason && record_present && recovery_load_postkill(g_dir, pk_name, kill_gen, &pk, &reason)) {
      // reason set by the loader (missing/unparseable/gen-mismatch/
      // token-inconsistent/bad-result).
    } else if (!reason && record_present) {
      if (memcmp(pk.token.val, leaf.token.val, sizeof(pk.token.val)) != 0) {
        reason = "token-mismatch";
      } else if (pk.pid != leaf.pid || pk.pidversion != leaf.pidversion) {
        reason = "pid-mismatch";
      } else if (pk.leaf_deadline != leaf.deadline) {
        reason = "deadline-mismatch";
      }
    }
    if (reason) {
      write_absent_receipt("fail", "postkill-checkpoint", reason, owner_r, owner_e,
                           helper_r, helper_e, 0, 0, kill_gen, unknown_mode ? "present" : NULL,
                           time(NULL), leaf.deadline, leaf.pid);
      return 1;
    }
    if (!record_present) {
      // Genuine ENOENT: R2's own bounded exact-token probe is the only
      // evidence. The conclusion may honestly be "already absent, cause
      // unknown" - never kill success or attribution - and a target that is
      // not ESRCH-absent within the bound fails closed. This mode never
      // sends SIGKILL either.
      int absent_errno = 0;
      int absent_probe = 0;
      int gone = wait_gone(&leaf.token, 3, &absent_probe, &absent_errno);
      if (gone != 1) {
        write_absent_receipt("fail", gone == 0 ? "target-alive" : "absent-probe",
                             gone == 0 ? "not-absent" : "probe-error", owner_r, owner_e,
                             helper_r, helper_e, absent_probe, absent_errno, kill_gen, "absent",
                             time(NULL), leaf.deadline, leaf.pid);
        return 1;
      }
      long recovered_at = time(NULL);
      int ok = recovered_at < leaf.deadline;
      write_absent_receipt(ok ? "ok" : "fail", "already-absent",
                           ok ? "cause-unknown" : "late",
                           owner_r, owner_e, helper_r, helper_e, absent_probe, absent_errno,
                           kill_gen, "absent", recovered_at, leaf.deadline, leaf.pid);
      return ok ? 0 : 1;
    }
    // Exact-token absence confirmation on the leaf's own authentic token.
    // Neither mode ever sends SIGKILL: a target that is not ESRCH-absent is a
    // failure, never something to kill or to declare already recovered.
    int absent_errno = 0;
    int absent_probe = probe(&leaf.token, SIGUSR1, &absent_errno);
    if (absent_probe != ESRCH) {
      write_absent_receipt("fail", "target-alive", "not-absent", owner_r, owner_e,
                           helper_r, helper_e, absent_probe, absent_errno,
                           kill_gen, unknown_mode ? "confirmed" : NULL,
                           time(NULL), leaf.deadline, leaf.pid);
      return 1;
    }
    long recovered_at = time(NULL);
    int ok = recovered_at < leaf.deadline;
    write_absent_receipt(ok ? "ok" : "fail", "already-absent", ok ? "confirmed" : "late",
                         owner_r, owner_e, helper_r, helper_e, absent_probe, absent_errno,
                         kill_gen, unknown_mode ? "confirmed" : NULL,
                         recovered_at, leaf.deadline, leaf.pid);
    return ok ? 0 : 1;
  }

  int alive_before_kill = probe(&leaf.token, SIGUSR1, &alive_errno) == 0;
  if (!alive_before_kill) {
    write_receipt("fail", "leaf-liveness", owner_r, owner_e, helper_r, helper_e,
                  0, alive_errno, 0, 0, 0, 0, time(NULL), leaf.deadline, leaf.pid);
    return 1;
  }

  int kill_return = probe(&leaf.token, SIGKILL, &kill_errno);
  int gone = kill_return == 0 ? wait_gone(&leaf.token, 5, &gone_r, &gone_e) : 0;
  long recovered_at = time(NULL);

  if (mode == MODE_KILL_THEN_PARK || mode == MODE_KILL_PARK_PRECHECK) {
    // Publish a checkpoint only after the kill was confirmed gone; then park
    // BEFORE the receipt on a gate the experiment never opens, so a process
    // crash here leaves the kill record but no receipt.
    if (kill_return != 0 || gone != 1) {
      write_receipt("fail", kill_return != 0 ? "kill" : "not-gone", owner_r, owner_e,
                    helper_r, helper_e, alive_before_kill, alive_errno, kill_return, kill_errno,
                    gone == 1 ? 1 : gone_r, gone_e, recovered_at, leaf.deadline, leaf.pid);
      return 1;
    }
    if (mode == MODE_KILL_PARK_PRECHECK) {
      // Deterministic test-only park point inside the kill-to-checkpoint
      // window: the kill is confirmed gone (ESRCH above) but NO postkill
      // record or receipt has been published yet. The harness never opens
      // checkpoint-gate, so a supervisor killed while parked leaves neither.
      char precheck_path[4096];
      if ((size_t)snprintf(precheck_path, sizeof(precheck_path), "%s/%s", g_dir, g_precheck_name) >= sizeof(precheck_path) ||
          recovery_write_atomic(precheck_path, "stage=checkpoint-wait\n", strlen("stage=checkpoint-wait\n"))) {
        write_receipt("fail", "precheck-marker", owner_r, owner_e, helper_r, helper_e,
                      alive_before_kill, alive_errno, kill_return, kill_errno,
                      gone == 1 ? 1 : gone_r, gone_e, recovered_at, leaf.deadline, leaf.pid);
        return 1;
      }
      if (wait_file(g_checkpoint_gate_name, 8)) {
        write_receipt("fail", "checkpoint-gate", owner_r, owner_e, helper_r, helper_e,
                      alive_before_kill, alive_errno, kill_return, kill_errno,
                      gone == 1 ? 1 : gone_r, gone_e, recovered_at, leaf.deadline, leaf.pid);
        return 1;
      }
    }
    postkill_t pk = {0};
    snprintf(pk.gen, sizeof(pk.gen), "%s", argv[2]);
    pk.pid = leaf.pid;
    pk.pidversion = leaf.pidversion;
    pk.token = leaf.token;
    pk.killed_at = recovered_at;
    pk.leaf_deadline = leaf.deadline;
    pk.kill_return = kill_return;
    pk.kill_errno = kill_errno;
    pk.gone = gone;
    pk.gone_errno = gone_e;
    if (recovery_write_postkill(g_dir, g_postkill_name, &pk)) {
      write_receipt("fail", "postkill-checkpoint", owner_r, owner_e, helper_r, helper_e,
                    alive_before_kill, alive_errno, kill_return, kill_errno,
                    gone == 1 ? 1 : gone_r, gone_e, recovered_at, leaf.deadline, leaf.pid);
      return 1;
    }
    if (wait_file(g_receipt_gate_name, 8)) {
      write_receipt("fail", "receipt-gate", owner_r, owner_e, helper_r, helper_e,
                    alive_before_kill, alive_errno, kill_return, kill_errno,
                    gone == 1 ? 1 : gone_r, gone_e, recovered_at, leaf.deadline, leaf.pid);
      return 1;
    }
    write_receipt("ok", "recovery", owner_r, owner_e, helper_r, helper_e,
                  alive_before_kill, alive_errno, kill_return, kill_errno,
                  gone == 1 ? 1 : gone_r, gone_e, recovered_at, leaf.deadline, leaf.pid);
    return 0;
  }

  int ok = alive_before_kill && kill_return == 0 && gone == 1 &&
           recovered_at < leaf.deadline;
  write_receipt(ok ? "ok" : "fail", "recovery", owner_r, owner_e, helper_r, helper_e,
                alive_before_kill, alive_errno, kill_return, kill_errno,
                gone == 1 ? 1 : gone_r, gone_e, recovered_at, leaf.deadline, leaf.pid);
  return ok ? 0 : 1;
}
