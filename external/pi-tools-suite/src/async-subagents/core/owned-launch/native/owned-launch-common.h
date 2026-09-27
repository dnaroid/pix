// Shared primitives for the owned-launch native programs (bridge,
// supervisor, worker gate). macOS-only candidate production code for
// durable detached-descendant containment; see owned-launch/README.md for
// the full protocol and claim boundaries.
//
// Private ABI notes (same convention as the proven feasibility fixtures):
// - PROC_PIDCOALITIONINFO / struct proc_pidcoalitioninfo copied from Apple
//   XNU bsd/sys/proc_info_private.h (d8b8029) — private, may drift.
// - coalition_info_resource_usage(uint64_t cid, void *ru) is exported by
//   libsystem_kernel (nm-verified on this host). The kernel's resource
//   usage struct is ~0x1f0 bytes and its first two u64 fields are
//   tasks_started / tasks_exited (XNU osfmk/mach/coalition.h:113-115).
//   We always pass a 2 KiB zeroed buffer and read only offsets 0/8, so a
//   larger future struct cannot overflow and a smaller one under-fills
//   harmlessly. ESRCH (3) is returned for unknown/reaped coalition ids and
//   the buffer is left untouched on error (host-observed).
// - Audit tokens are kernel-issued only. External acquisition uses the
//   unprivileged task_name_for_pid + task_info(TASK_AUDIT_TOKEN) route
//   (XNU kern_proc.c task_name_for_pid permits same-euid+ruid callers on
//   non-zombie targets); signaling uses proc_signal_with_audittoken,
//   whose kernel lookup validates only the embedded PID (val[5]) and
//   PID-version (val[7]) and returns ESRCH on generation mismatch.
//   signum 0 is rejected with EINVAL, and SIGUSR1 would terminate a
//   default-disposition process, so no signal-based liveness probing
//   exists anywhere in owned-launch. The only signal ever sent to a
//   noncooperative process is SIGKILL through an authentic token.
#ifndef OWNED_LAUNCH_COMMON_H
#define OWNED_LAUNCH_COMMON_H

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
#include <sys/stat.h>
#include <sys/sysctl.h>
#include <sys/types.h>
#include <time.h>
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
  uint8_t p_uuid[16];
  uint64_t p_uniqueid;
  uint64_t p_puniqueid;
  int32_t p_idversion;
  int32_t p_orig_ppidversion;
  uint64_t p_reserve2;
  uint64_t p_reserve3;
};
_Static_assert(sizeof(struct proc_uniqidentifierinfo) == 56, "XNU uniq identifier ABI size");

#define OL_UNUSED __attribute__((unused))
#define OL_PATH_MAX 4096
#define OL_SPEC_MAX_BYTES (4u * 1024u * 1024u)
#define OL_SPEC_MAX_ITEMS 8192
#define OL_COALITION_USAGE_BUF 2048

// ---------------------------------------------------------------- time ---

static void OL_UNUSED ol_sleep_ms(long ms) {
  struct timespec ts = { ms / 1000, (ms % 1000) * 1000000L };
  nanosleep(&ts, NULL);
}

static long OL_UNUSED ol_now_sec(void) { return (long)time(NULL); }

// ------------------------------------------------------- boot identity ---

// kern.boottime changes only across reboots; coalition ids are monotonic
// within a boot and are not reused before a reboot (XNU coalition_next_id
// only increments; ids leave the hash only at reap). Binding a recorded
// coalition id to the boot identity lets every reader refuse to act on a
// journal that predates the current boot.
static int OL_UNUSED ol_boot_identity(uint64_t *sec, uint64_t *usec) {
  struct timeval tv;
  size_t len = sizeof(tv);
  int mib[2] = { CTL_KERN, KERN_BOOTTIME };
  memset(&tv, 0, sizeof(tv));
  if (sysctl(mib, 2, &tv, &len, NULL, 0) != 0) return -1;
  if (len != sizeof(tv) || tv.tv_sec == 0) return -1;
  *sec = (uint64_t)tv.tv_sec;
  *usec = (uint64_t)tv.tv_usec;
  return 0;
}

// ------------------------------------------------------------ atomics ----

// tmp + fsync + rename. Optionally fsync the parent directory so the rename
// itself is durable (journals use dir_fsync=1 before any gate release).
static int OL_UNUSED ol_write_atomic(const char *path, const char *buf, size_t len,
                           mode_t mode, int dir_fsync) {
  char tmp[OL_PATH_MAX];
  if ((size_t)snprintf(tmp, sizeof(tmp), "%s.tmp.XXXXXX", path) >= sizeof(tmp)) return -1;
  int fd = mkstemp(tmp);
  if (fd < 0) return -1;
  if (fchmod(fd, mode)) { close(fd); unlink(tmp); return -1; }
  size_t off = 0;
  while (off < len) {
    ssize_t k = write(fd, buf + off, len - off);
    if (k <= 0) { close(fd); unlink(tmp); return -1; }
    off += (size_t)k;
  }
  if (fsync(fd)) { close(fd); unlink(tmp); return -1; }
  if (close(fd)) { unlink(tmp); return -1; }
  if (rename(tmp, path)) { unlink(tmp); return -1; }
  if (dir_fsync) {
    char dir[OL_PATH_MAX];
    const char *slash = strrchr(path, '/');
    size_t n;
    if (!slash) return -1;
    n = (size_t)(slash - path) == 0 ? 1 : (size_t)(slash - path);
    if (n >= sizeof(dir)) return -1;
    memcpy(dir, path, n);
    dir[n] = '\0';
    int dfd = open(dir, O_RDONLY | O_DIRECTORY);
    if (dfd < 0) return -1;
    int synced = fsync(dfd);
    int closed = close(dfd);
    if (synced || closed) return -1;
  }
  return 0;
}

static int OL_UNUSED ol_wait_file(const char *dir, const char *name, long seconds) {
  char path[OL_PATH_MAX];
  if ((size_t)snprintf(path, sizeof(path), "%s/%s", dir, name) >= sizeof(path)) return -1;
  struct timespec start, now;
  clock_gettime(CLOCK_MONOTONIC, &start);
  for (;;) {
    struct stat st;
    if (lstat(path, &st) == 0 && S_ISREG(st.st_mode)) return 0;
    clock_gettime(CLOCK_MONOTONIC, &now);
    if (now.tv_sec - start.tv_sec >= seconds) return -1;
    ol_sleep_ms(20);
  }
}

// --------------------------------------------------------- coalition -----

extern int coalition_info_resource_usage(uint64_t cid, void *ru);

// 0 ok; 3 ESRCH (unknown/reaped); -1 unexpected errno in *err.
static int OL_UNUSED ol_coalition_usage(uint64_t cid, uint64_t *started, uint64_t *exited, int *err) {
  unsigned char buf[OL_COALITION_USAGE_BUF];
  memset(buf, 0, sizeof(buf));
  errno = 0;
  int r = coalition_info_resource_usage(cid, buf);
  if (r == 0) {
    memcpy(started, buf, 8);
    memcpy(exited, buf + 8, 8);
    return 0;
  }
  *err = errno ? errno : EIO;
  if (*err == ESRCH) return 3;
  return -1;
}

// Resource coalition id of a live process; -1 on any failure.
static int OL_UNUSED ol_pid_cid(pid_t pid, uint64_t *cid) {
  struct proc_pidcoalitioninfo info;
  memset(&info, 0, sizeof(info));
  int n = proc_pidinfo(pid, PROC_PIDCOALITIONINFO, 0, &info, sizeof(info));
  if (n != (int)sizeof(info)) return -1;
  *cid = info.coalition_id[0];
  return 0;
}

// PID version via the private uniq-identifier flavor (XNU fills p_idversion
// with proc_pidversion(p), the same field the kernel checks against
// audit_token val[7]). -1 on failure.
static int OL_UNUSED ol_pid_pidversion(pid_t pid, int32_t *pidversion) {
  struct proc_uniqidentifierinfo uniq;
  memset(&uniq, 0, sizeof(uniq));
  int n = proc_pidinfo(pid, PROC_PIDUNIQIDENTIFIERINFO, 0, &uniq, sizeof(uniq));
  if (n != (int)sizeof(uniq)) return -1;
  *pidversion = uniq.p_idversion;
  return 0;
}

// ------------------------------------------------------------ tokens -----

static int OL_UNUSED ol_self_token(audit_token_t *token) {
  mach_msg_type_number_t count = TASK_AUDIT_TOKEN_COUNT;
  memset(token, 0, sizeof(*token));
  if (task_info(mach_task_self(), TASK_AUDIT_TOKEN, (task_info_t)token, &count) != KERN_SUCCESS ||
      count != TASK_AUDIT_TOKEN_COUNT)
    return -1;
  return 0;
}

// External acquisition of a noncooperative target's kernel-issued audit
// token (unprivileged same-euid route). The port is always released.
static int OL_UNUSED ol_pid_token(pid_t pid, audit_token_t *token) {
  mach_port_name_t port = MACH_PORT_NULL;
  memset(token, 0, sizeof(*token));
  if (task_name_for_pid(mach_task_self(), pid, &port) != KERN_SUCCESS || !MACH_PORT_VALID(port))
    return -1;
  mach_msg_type_number_t count = TASK_AUDIT_TOKEN_COUNT;
  kern_return_t kr = task_info(port, TASK_AUDIT_TOKEN, (task_info_t)token, &count);
  (void)mach_port_deallocate(mach_task_self(), port);
  if (kr != KERN_SUCCESS || count != TASK_AUDIT_TOKEN_COUNT) return -1;
  if (audit_token_to_pid(*token) != pid || audit_token_to_pidversion(*token) <= 0) return -1;
  return 0;
}

// The only signal primitive used against noncooperative processes anywhere
// in owned-launch: kernel-validated exact-generation SIGKILL.
static int OL_UNUSED ol_token_kill(const audit_token_t *token) {
  errno = 0;
  return proc_signal_with_audittoken((audit_token_t *)token, SIGKILL);
}

// ------------------------------------------------------------ members ----

// Member discovery for the drain: every pid whose resource coalition id
// matches the owned id. Returns count found, or -1 on enumeration failure.
static int OL_UNUSED ol_members(uint64_t cid, pid_t *out, int max) {
  int total = proc_listallpids(NULL, 0);
  if (total <= 0) return -1;
  pid_t *all = calloc((size_t)total, sizeof(pid_t));
  if (!all) return -1;
  int n = proc_listallpids(all, (int)((size_t)total * sizeof(pid_t)));
  if (n <= 0) { free(all); return -1; }
  int found = 0;
  for (int i = 0; i < n && found < max; i++) {
    uint64_t c = 0;
    if (ol_pid_cid(all[i], &c) == 0 && c == cid) out[found++] = all[i];
    // pids whose coalition cannot be read (e.g. zombies, other users) are
    // never signaled; kernel accounting remains the completion oracle.
  }
  free(all);
  return found;
}

// --------------------------------------------------------------- spec ----

typedef struct {
  char command[OL_PATH_MAX];
  char cwd[OL_PATH_MAX];
  char sockets_dir[OL_PATH_MAX];
  char supervisor_binary[OL_PATH_MAX];
  char gate_binary[OL_PATH_MAX];
  char label_supervisor[128];
  char label_worker[128];
  long watchdog_seconds;
  long release_timeout_seconds;
  long drain_deadline_seconds;
  long args_count;
  char (*args)[OL_PATH_MAX];
  long env_count;
  char **env; // each "NAME=value", heap
} ol_spec_t;

static void OL_UNUSED ol_spec_free(ol_spec_t *s) {
  free(s->args);
  if (s->env) {
    for (long i = 0; i < s->env_count; i++) free(s->env[i]);
    free(s->env);
  }
  memset(s, 0, sizeof(*s));
}

static int OL_UNUSED ol_parse_long(const char *v, long len, long *out) {
  if (len <= 0 || len > 12) return -1;
  long r = 0;
  for (long i = 0; i < len; i++) {
    if (v[i] < '0' || v[i] > '9') return -1;
    r = r * 10 + (v[i] - '0');
  }
  *out = r;
  return 0;
}

// Strict sequential parser for the spec format documented in README.md:
//   scalar key=value lines first (including args_count / env_count), then
//   arg:<i>:<len>=<len raw bytes> entries, then env:<i>:<len>= entries.
// The parser never searches inside payload bytes; every item is consumed
// positionally, so payload content cannot be confused with framing. Fails
// closed on any unknown key, missing key, ordering violation, size/count
// bound, or embedded NUL.
static int OL_UNUSED ol_load_spec(const char *dir, ol_spec_t *s) {
  char path[OL_PATH_MAX];
  memset(s, 0, sizeof(*s));
  if ((size_t)snprintf(path, sizeof(path), "%s/spec.txt", dir) >= sizeof(path)) return -1;
  int fd = open(path, O_RDONLY | O_NOFOLLOW);
  if (fd < 0) return -1;
  size_t cap = 65536, used = 0;
  char *buf = malloc(cap);
  if (!buf) { close(fd); return -1; }
  for (;;) {
    if (used == cap) {
      if (cap >= OL_SPEC_MAX_BYTES) { free(buf); close(fd); return -1; }
      cap *= 2;
      char *nb = realloc(buf, cap);
      if (!nb) { free(buf); close(fd); return -1; }
      buf = nb;
    }
    ssize_t n = read(fd, buf + used, cap - used);
    if (n < 0) { if (errno == EINTR) continue; free(buf); close(fd); return -1; }
    if (n == 0) break;
    used += (size_t)n;
  }
  close(fd);
  if (used == 0 || used >= OL_SPEC_MAX_BYTES) { free(buf); return -1; }
  if (memchr(buf, '\0', used)) { free(buf); return -1; }

  size_t pos = 0;
  static const char *scalar_names[] = { "version", "command", "cwd", "sockets_dir", "supervisor_binary",
      "gate_binary", "label_supervisor", "label_worker", "watchdog_seconds", "release_timeout_seconds",
      "drain_deadline_seconds" };
  unsigned scalars_seen = 0;
  int seen_payload = 0, seen_args_count = 0, seen_env_count = 0;
  long seen_args = 0, seen_envs = 0;
  while (pos < used) {
    if (used - pos >= 4 && (!memcmp(buf + pos, "arg:", 4) || !memcmp(buf + pos, "env:", 4))) {
      int arg = !memcmp(buf + pos, "arg:", 4);
      char *eq = memchr(buf + pos, '=', used - pos);
      char *nl = memchr(buf + pos, '\n', used - pos);
      if (!eq || !nl || eq > nl || eq - (buf + pos) > 32) { free(buf); return -1; }
      char *colon = memchr(buf + pos + 4, ':', (size_t)(eq - (buf + pos + 4)));
      long idx = 0, len = 0;
      if (!colon || ol_parse_long(buf + pos + 4, (long)(colon - (buf + pos + 4)), &idx) ||
          ol_parse_long(colon + 1, (long)(eq - colon - 1), &len) ||
          (size_t)(eq + 1 - buf) + (size_t)len >= used ||
          eq[1 + len] != '\n') { free(buf); return -1; }
      const char *val = eq + 1;
      if (arg) {
        if (!seen_args_count || seen_payload == 2 || idx != seen_args || idx >= s->args_count || len >= OL_PATH_MAX) { free(buf); return -1; }
        memcpy(s->args[idx], val, (size_t)len);
        s->args[idx][len] = '\0';
        seen_args++;
        seen_payload = 1;
      } else {
        if (!seen_env_count || idx != seen_envs || idx >= s->env_count || !memchr(val, '=', (size_t)len)) { free(buf); return -1; }
        char *e = malloc((size_t)len + 1);
        if (!e) { free(buf); return -1; }
        memcpy(e, val, (size_t)len);
        e[len] = '\0';
        s->env[idx] = e;
        seen_envs++;
        seen_payload = 2;
      }
      pos = (size_t)(eq + 2 + len - buf);
      continue;
    }
    char *line_end = memchr(buf + pos, '\n', used - pos);
    if (!line_end) { free(buf); return -1; }
    size_t line_len = (size_t)(line_end - (buf + pos));
    char *ln = buf + pos;
    pos += line_len + 1;
    if (line_len == 0) { free(buf); return -1; }
    char *eq = memchr(ln, '=', line_len);
    if (!eq) { free(buf); return -1; }
    size_t key_len = (size_t)(eq - ln);
    const char *val = eq + 1;
    size_t val_len = line_len - key_len - 1;
    if (key_len == 0 || val_len == 0) { free(buf); return -1; }

    if (seen_payload) { free(buf); return -1; } // scalars must all precede payload
    char field[32];
    if (key_len >= sizeof(field)) { free(buf); return -1; }
    memcpy(field, ln, key_len);
    field[key_len] = '\0';
    for (unsigned i = 0; i < sizeof(scalar_names) / sizeof(scalar_names[0]); i++) {
      if (strcmp(field, scalar_names[i]) == 0) {
        if (scalars_seen & (1u << i)) { free(buf); return -1; }
        scalars_seen |= 1u << i;
        break;
      }
    }
    char *dest = NULL;
    size_t dest_sz = 0;
    if (!strcmp(field, "command")) { dest = s->command; dest_sz = sizeof(s->command); }
    else if (!strcmp(field, "cwd")) { dest = s->cwd; dest_sz = sizeof(s->cwd); }
    else if (!strcmp(field, "sockets_dir")) { dest = s->sockets_dir; dest_sz = sizeof(s->sockets_dir); }
    else if (!strcmp(field, "supervisor_binary")) { dest = s->supervisor_binary; dest_sz = sizeof(s->supervisor_binary); }
    else if (!strcmp(field, "gate_binary")) { dest = s->gate_binary; dest_sz = sizeof(s->gate_binary); }
    else if (!strcmp(field, "label_supervisor")) { dest = s->label_supervisor; dest_sz = sizeof(s->label_supervisor); }
    else if (!strcmp(field, "label_worker")) { dest = s->label_worker; dest_sz = sizeof(s->label_worker); }
    else {
      long num = 0;
      if (!strcmp(field, "args_count")) {
        if (seen_args_count || ol_parse_long(val, (long)val_len, &num) || num < 0 || num > OL_SPEC_MAX_ITEMS)
          { free(buf); return -1; }
        seen_args_count = 1;
        s->args_count = num;
        if (num) { s->args = calloc((size_t)num, OL_PATH_MAX); if (!s->args) { free(buf); return -1; } }
        continue;
      }
      if (!strcmp(field, "env_count")) {
        if (seen_env_count || ol_parse_long(val, (long)val_len, &num) || num < 0 || num > OL_SPEC_MAX_ITEMS)
          { free(buf); return -1; }
        seen_env_count = 1;
        s->env_count = num;
        if (num) { s->env = calloc((size_t)num, sizeof(char *)); if (!s->env) { free(buf); return -1; } }
        continue;
      }
      if (ol_parse_long(val, (long)val_len, &num)) { free(buf); return -1; }
      if (!strcmp(field, "watchdog_seconds")) s->watchdog_seconds = num;
      else if (!strcmp(field, "release_timeout_seconds")) s->release_timeout_seconds = num;
      else if (!strcmp(field, "drain_deadline_seconds")) s->drain_deadline_seconds = num;
      else if (!strcmp(field, "version")) { if (num != 1) { free(buf); return -1; } }
      else { free(buf); return -1; }
      continue;
    }
    if (val_len >= dest_sz) { free(buf); return -1; }
    memcpy(dest, val, val_len);
    dest[val_len] = '\0';
  }
  free(buf);
  if (!s->command[0] || !s->cwd[0] || !s->sockets_dir[0] || !s->supervisor_binary[0] ||
      !s->gate_binary[0] || !s->label_supervisor[0] || !s->label_worker[0] ||
      s->watchdog_seconds <= 0 || s->release_timeout_seconds <= 0 || s->drain_deadline_seconds <= 0 ||
      scalars_seen != (1u << (sizeof(scalar_names) / sizeof(scalar_names[0]))) - 1 ||
      !seen_args_count || !seen_env_count || seen_args != s->args_count || seen_envs != s->env_count)
    return -1;
  return 0;
}

#endif // OWNED_LAUNCH_COMMON_H
