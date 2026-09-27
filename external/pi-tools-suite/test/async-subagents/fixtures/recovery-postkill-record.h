// Published postkill checkpoint record contract for the offline macOS recovery
// supervisor family (fixtures/recovery-supervisor.c and its opt-in restart
// modes). Split out of the supervisor so the record format, its strict
// loader, and the identity rules it enforces have a single owner while the
// supervisor keeps mode dispatch and lifecycle.
//
// Record shape (one line, single trailing newline, no NULs, no trailing
// fields):
//   role=postkill gen=<g> pid=<pid> pidversion=<v> token=<64 hex>
//   killed_at=<t> leaf_deadline=<d> kill_return=<r> kill_errno=<e>
//   gone=<g> gone_errno=<e>
//
// Invariants enforced here:
// - the record is only ever written AFTER the exact-generation SIGKILL was
//   confirmed gone (ESRCH); it never upgrades intent into outcome;
// - the strict loader accepts only a well-formed, internally consistent
//   record claiming a successful confirmed kill of the requested generation;
//   every failure keeps a short stable reason string for fail-closed
//   receipts ("missing" for any open failure, matching the original
//   in-supervisor loader byte for byte);
// - the token must itself identify the recorded PID and PID-version via the
//   libbsm accessors, so a reused PID can never validate as the recorded
//   actor.
// This is a test fixture header, not a production checkpoint API.
#ifndef RECOVERY_POSTKILL_RECORD_H
#define RECOVERY_POSTKILL_RECORD_H

#include <bsm/libbsm.h>
#include <errno.h>
#include <stdio.h>
#include <string.h>

// Provided by the including translation unit (the supervisor owns atomic
// publication): write buf to path through tmp file + fsync + rename.
int recovery_write_atomic(const char *path, const char *buf, size_t len);

typedef struct {
  char gen[24];
  pid_t pid;
  int pidversion;
  audit_token_t token;
  long killed_at;
  long leaf_deadline;
  int kill_return;
  int kill_errno;
  int gone;
  int gone_errno;
} postkill_t;

// Record published only after the exact-generation SIGKILL was
// confirmed gone (ESRCH). It names the exact killed actor identity, the
// generation that performed the kill, and the observed result. A restart
// owner may attribute absence to this kill only if this record validates
// and its own probe confirms absence. Publication is not power-loss proof.
static int recovery_write_postkill(const char *dir, const char *name, const postkill_t *pk) {
  char path[4096], buf[768];
  if ((size_t)snprintf(path, sizeof(path), "%s/%s", dir, name) >= sizeof(path)) return -1;
  int n = snprintf(buf, sizeof(buf),
      "role=postkill gen=%s pid=%d pidversion=%d "
      "token=%08x%08x%08x%08x%08x%08x%08x%08x killed_at=%ld leaf_deadline=%ld "
      "kill_return=%d kill_errno=%d gone=%d gone_errno=%d\n",
      pk->gen, pk->pid, pk->pidversion,
      pk->token.val[0], pk->token.val[1], pk->token.val[2], pk->token.val[3],
      pk->token.val[4], pk->token.val[5], pk->token.val[6], pk->token.val[7],
      pk->killed_at, pk->leaf_deadline, pk->kill_return, pk->kill_errno,
      pk->gone, pk->gone_errno);
  if (n <= 0 || (size_t)n >= sizeof(buf)) return -1;
  return recovery_write_atomic(path, buf, (size_t)n);
}

// Strict loader for a postkill checkpoint. Returns 0 only for a well-formed,
// internally consistent record claiming a successful confirmed kill of the
// requested generation; otherwise -1 with a short stable reason string for
// the failure receipt. This NEVER turns an arbitrary dead PID into success:
// the caller still cross-checks the identity against leaf.json and probes the
// leaf's own audit token for ESRCH. "missing" covers every open failure so
// the legacy already-absent contract stays byte-identical; callers that must
// distinguish a genuinely ENOENT-absent record do so before calling this.
static int recovery_load_postkill(const char *dir, const char *name, const char *want_gen,
    postkill_t *pk, const char **reason) {
  char path[4096], line[768], role[32], gen[32], token[65];
  *reason = "missing";
  if ((size_t)snprintf(path, sizeof(path), "%s/%s", dir, name) >= sizeof(path)) {
    *reason = "path-overflow";
    return -1;
  }
  FILE *f = fopen(path, "r");
  if (!f) return -1;
  *reason = "unparseable";
  size_t length = fread(line, 1, sizeof(line) - 1, f);
  int extra = fgetc(f);
  int read_error = ferror(f);
  fclose(f);
  if (!length || extra != EOF || read_error || memchr(line, '\0', length)) return -1;
  line[length] = '\0';
  unsigned int v[8];
  int consumed = 0;
  int n = sscanf(line,
      "role=%31s gen=%31s pid=%d pidversion=%d token=%64[0123456789abcdefABCDEF] "
      "killed_at=%ld leaf_deadline=%ld kill_return=%d kill_errno=%d gone=%d gone_errno=%d%n",
      role, gen, &pk->pid, &pk->pidversion, token, &pk->killed_at, &pk->leaf_deadline,
      &pk->kill_return, &pk->kill_errno, &pk->gone, &pk->gone_errno, &consumed);
  if (n != 11 || strcmp(role, "postkill") != 0 || strlen(token) != 64 ||
      strcmp(line + consumed, "\n") != 0) return -1;
  for (int i = 0; i < 8; i++) {
    if (sscanf(token + i * 8, "%8x", &v[i]) != 1) return -1;
  }
  for (int i = 0; i < 8; i++) pk->token.val[i] = v[i];
  if (strlen(gen) >= sizeof(pk->gen) || strcmp(gen, want_gen) != 0) {
    *reason = "gen-mismatch";
    return -1;
  }
  snprintf(pk->gen, sizeof(pk->gen), "%s", gen);
  // The recorded token must itself identify the recorded PID and PID-version.
  if (audit_token_to_pid(pk->token) != pk->pid ||
      audit_token_to_pidversion(pk->token) != pk->pidversion) {
    *reason = "token-inconsistent";
    return -1;
  }
  // Only a checkpoint that recorded a delivered SIGKILL and a confirmed ESRCH
  // may justify a checkpoint-confirmed conclusion, and only before the leaf's
  // own watchdog fired.
  if (pk->kill_return != 0 || pk->kill_errno != 0 || pk->gone != 1 ||
      pk->gone_errno != ESRCH || pk->killed_at <= 0 || !(pk->killed_at < pk->leaf_deadline)) {
    *reason = "bad-result";
    return -1;
  }
  // Success: clear any intermediate reason so the caller's fail-closed check
  // sees no failure.
  *reason = NULL;
  return 0;
}

#endif // RECOVERY_POSTKILL_RECORD_H
