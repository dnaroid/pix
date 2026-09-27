# owned-launch — durable detached-descendant containment launcher (candidate)

macOS-only candidate implementation of the G1/T3 containment architecture.
Draft integration in `core/spawn.ts` selects this launcher for
`pi-claude-code-provider`; runtime stop, recovery, and cleanup also participate.
This wiring is **not yet accepted**: the real Pi/provider lifecycle matrix and
independent review must pass before G1/T3 can close.

Goal: a launched sub-agent's **entire descendant tree** — including
detached, `setsid`'d, exec'd, TERM-resistant descendants — is durably owned
and cleaned up even when Pi, the bridge, and the worker are lost
simultaneously, with **no PID-based kill fallback**, no lost fork race, and
no signal ever sent to an unrelated process.

## Topology

```
Pi (parent)
 └─ bridge                 detached process-group leader (parent's direct
     │                     child; stdio JSONL RPC preserved; group signals
     │                     reach only the bridge)
     │ bootstraps (gui/<uid>, KeepAlive)
     ▼
  launchd ── supervisor    per-run UUID job; survives Pi/bridge/worker loss;
     │                     owns worker job creation; journals before release
     │ bootstraps (gui/<uid>, RunAtLoad, no KeepAlive)
     ▼
  launchd ── worker gate   per-run UUID job with its OWN fresh launchd
     │                     resource coalition; parks until release, then
     │                     forks a waitable payload (pi) in that coalition
     └─ payload + all descendants (setsid/exec/…) stay in the coalition
```

Per-run UUID labels (`org.pix.<uuid>`) mean every launchctl action can only
ever address jobs this launcher created; cleanup never sweeps by name or
PID.

## Launch sequence and durable ownership

1. **TS launcher** (`launcher.ts`): prepare binaries asynchronously, then
   `launchOwnedAgentSync({ binaries, … })` performs a normal synchronous
   spawn using prebuilt binaries (the compatibility `launchOwnedAgent()`
   wrapper prepares asynchronously). It creates a 0700
   hidden staging dir and atomically publishes the complete spec under a fresh
   UUID (existing path refused), resolves a sockets dir
   (0700; short paths keep sockets beside the journal, long paths use a
   fresh `mkdtemp` so `sockaddr_un.sun_path` stays under 104 bytes), writes
   the 0600 `spec.txt` (borrowed env/argv/cwd + binary paths + labels +
   timeouts) plus `claim_protocol` and a strictly increasing `generation`, invokes `beforeSpawn` to persist runtime
   ownership metadata,
   then spawns the bridge detached with piped stdio and a
   minimal environment (`/bin/launchctl` is reached by absolute path).
2. **Bridge** (`native/owned-launch-bridge.c`): validates 0700/ownership of
   run and sockets dirs; takes the **exclusive launch claim** (`claim`,
   published with `link(2)`; exit 17 when restart recovery already fenced
   the run, 18 on claim I/O failure — both before any bind or launchctl
   action; if the claim was already published, 18/13/14 first write a
   durable `prelaunch_abort` record); binds four 0600 UNIX listeners (`control.sock`,
   `stdin.sock`, `stdout.sock`, `stderr.sock`; `EADDRINUSE` fails closed —
   stale entries are never unlinked); writes its diagnostic identity;
   bootstraps the **supervisor** launchd job (KeepAlive) and verifies
   `launchctl print` sees it; arms a 90 s root startup watchdog; then
   relays stdio. The bridge never creates the worker job and never signals
   anything.
3. **Supervisor** (`native/owned-launch-supervisor.c`): connects the
   control socket (fail closed if the bridge never appears — no worker job
   exists yet, so nothing was released); creates the **worker** launchd job
   itself (the bridge-bootstrap race is structurally avoided); waits for
   the gate's `worker.json`.
4. **Worker gate** (`native/owned-launch-worker-gate.c`): obtains its
   kernel-issued audit token, its job's fresh resource coalition id, and
   the boot identity; connects the stdio sockets (it never reads them, so
   prompt bytes stay queued in the sockets across the park); publishes
   `worker.json` atomically; parks on the `release` marker (bounded).
5. **Supervisor validates and journals before release**: it independently
   re-acquires the token (`task_name_for_pid` + `TASK_AUDIT_TOKEN`) and
   re-reads the pid's coalition id, requiring both to match the record, the
   boot identity to match the current boot, and the coalition to differ
   from its own; writes `owned.json` (boot identity + coalition id + worker
   identity) with fsync **and** directory fsync; only then creates
   `release`. **No payload work can be released without a durable,
   boot-bound drain obligation existing first.**
6. Gate writes `gate-handoff`, forks and waits for its child to `execvp` the payload with a fresh
   environment built only from the spec (nothing leaks from launchd's job
   environment); the gate durably writes `payload-exit.json` with the
   actual exit code before exiting; exec failures write `gate-exit.json` so the supervisor
   reports a fatal startup failure instead of natural completion.

## Monitoring and drain

The supervisor polls (100 ms):

- **control EOF** ⇒ Pi/bridge loss (including SIGKILL of the whole bridge
  group) ⇒ cancel;
- **disk cancel marker** (`cancel` in the run dir) ⇒ cancel. The launcher's
  `stop()` writes it durably (tmp + fsync + rename + dir fsync) **before**
  attempting SIGTERM, so this leg works with no live bridge, no signal
  path, and no active TS handle at all — any authorized writer that knows
  the run dir can order the cancel. The supervisor checks it immediately
  before creating the release gate and on every monitoring iteration; the
  parked gate also checks it once after release;
- **watchdog** (monotonic since start) ⇒ cancel;
- **kernel coalition accounting** (`coalition_info` flavor 1:
  `tasks_started` / `tasks_exited`) ⇒ empty coalition + `gate-handoff` and
  no `gate-exit.json` and a valid payload exit record ⇒ natural completion
  (bridge exits with the payload's code; missing status is fatal);
- bridge verdicts are relayed over control JSONL: `worker_released`,
  `worker_done`, `cancelled`, `fatal`.

**Drain** (cancel / watchdog / restart recovery / post-natural cleanup):
loop until the kernel oracle reports `started == exited` (or ESRCH, see
below); the drain deadline bounds each attempt, but KeepAlive ownership
and retry persist while completion is unconfirmed:

1. enumerate members: `proc_listallpids` filtered by
   `PROC_PIDCOALITIONINFO == owned cid` (private ABI copied from XNU, as in
   the proven fixtures);
2. for each member: acquire its authentic audit token (**token-before**),
   re-check the pid's coalition id and acquire the token again (**token-before/CID/token-after** — a recycled
   pid now owned by another coalition is never signaled), then
   `proc_signal_with_audittoken(token, SIGKILL)` only.

There is no PID `kill()` fallback, no process-group kill of payload
processes, and no liveness probing by signal anywhere (signum 0 is EINVAL
and SIGUSR1 would terminate default-disposition targets — only cooperating
fixture families may use it). Completion is the **kernel zero receipt**
(`started == exited`), never PID-sweep emptiness. `ESRCH` for the owned cid
counts as zero **only with the durable journal** (the kernel removes a
coalition from its hash only at reap, after its task count reached zero);
without durable birth evidence it fails closed. Capability mismatches
(token acquisition failure on a live member, unexpected coalition errno,
enumeration failure) are recorded and fail the claim unless the kernel
oracle still reaches zero — a genuine denial (e.g. a setuid member) can
never be reported as success, and a transient unreadable zombie cannot
produce a false failure after kernel-zero.

## Restart and crash windows

- Parent recovery keeps reconciling receipts and job retirement even after
  `exit_code` has been recovered. Elapsed grace, a missing journal and absent
  jobs never prove a pending UUID directory was not launched; hidden staging
  leftovers are not swept by age for the same reason.
- Parent crash after publish (before the pointer or before the bridge
  spawn): the directory is visible, complete and unclaimed. Recovery fences
  it by publishing `role=fence` as `claim` with the same `link(2)` rule the
  bridge uses; exactly one side can win. A won fence is the proof — a late
  bridge exits 17 before any bind/launchctl — so the directory becomes a
  `never-launched` outcome (exit 1), retired only after both UUID labels are
  confirmed absent. Recovery skips runs held by a live in-process handle and
  waits a grace period (liveness only); a parent whose own reaped bridge
  never claimed fences immediately. Runs without `claim_protocol` (older
  launchers) are never fenced and stay pending.
- Bridge deterministic failure after its claim but before any launchctl
  action (bind 13, plist 14, claim dir fsync 18) writes `prelaunch_abort`
  and classifies `never-launched`. A bridge crash, or a bootstrap failure
  (15), between claim and supervisor bootstrap is not resolved: the run
  stays pending (fail closed) because a live bridge or an orphaned
  `launchctl bootstrap` cannot be excluded without identity proof. Bridge
  exit cleanup unlinks only listeners the bridge bound.
- The agent's outcome is its newest generation's (`generation` record),
  never a stale pointer's; reconciliation leaves runs held by a live
  in-process handle to their own settle loop.
- Supervisor is KeepAlive: launchd restarts it after a crash. On restart it
  first looks for a **terminal receipt**: if `drain.json` already holds a
  terminal status (`ok`/`fail`), the run is concluded and the only
  remaining obligation is job retirement — it never re-drains, never
  resumes, and **never rewrites the successful receipt** (status, cause,
  and payload code stay exactly as recorded); it best-effort replays the
  recorded verdict to a still-live bridge, which covers a supervisor that
  died between the durable receipt write and the control send.
- Otherwise, if `owned.json` exists the supervisor **cancels, never
  resumes**: it validates the journal (strict parse, token↔pid↔pidversion
  consistency, boot identity match; a cross-boot journal is fatal because
  coalition ids are boot-monotonic) and immediately drains.
  `cause=restart_recovery`.
- Crash before journal: fresh start path re-runs idempotently (worker job
  creation is find-or-create).
- Crash between journal and release: restart drains the still-parked gate.
- Crash after release: restart drains the live payload coalition.
- Bridge death before release is a genuine race, not an atomic guarantee:
  the supervisor's control-liveness check and the release write are two
  separate operations. If the bridge dies before the check runs, nothing
  is released and the parked worker job is removed; if it dies inside the
  check→release window, the payload is released posthumously (the durable
  journal already existed, so the obligation is covered), it may briefly
  run, and the supervisor still contains it — control EOF drives the same
  drain to a kernel-zero receipt. The opt-in tests stage the window
  deterministically with the `test-hold-pre-release` barrier (no guessed
  delays).
- Pre-journal startup errors self-bootout; errors after journal creation
  drain before bootout. Unknown/failed drains retain KeepAlive ownership.

## Finish ordering and job retirement

`finish()` writes the **truthful kernel-zero receipt first**, durably,
before any teardown, and never rewrites it after success — job retirement
is tracked separately so a retirement failure can never alter a successful
receipt, cause, or payload code. Ordering:

1. durable `drain.json` (fsync + dir fsync);
2. bridge verdict over control (a restart replays it from the receipt if
   this instance died first);
3. worker job retirement: bounded-backoff `launchctl bootout` retries
   until `launchctl print` **confirms the service absent** — `print`
   execution errors are retried, never ignored (an unreadable answer
   counts as still-present). An unconfirmed retirement writes a
   `retire.json` diagnostic and **retains KeepAlive ownership** (no
   self-bootout), so every restart retries via the terminal-receipt path;
4. supervisor self-bootout — only after the worker job is confirmed
   absent. Self-bootout **cannot be self-certified** (the process is gone),
   so integrations must independently verify **both** per-run UUID labels
   are absent before deleting or reusing any run artifacts.

## Files

- `label.ts` — UUID labels, 0700 dir creation, sockets-dir budget.
- `spec.ts` — strict positional spec format (borrowed env/argv/cwd).
- `marker.ts` — durable disk cancel marker (tmp + fsync + rename + dir
  fsync); the disk leg of `stop()`. Also the exclusive launch claim
  (`claim`, `claim_protocol`) read/fence helpers for restart recovery.
- `bootstrap.ts` — async native build into a private 0700 cache keyed by a
  source hash; **fails closed** when `xcrun clang` is unavailable. No
  compiler ever runs synchronously on the parent's thread. Concurrent
  first launches in one process share a single build; separate processes
  build with private temp names and publish by atomic rename, so parallel
  builders and crashed-build leftovers never fail a launch.
- `launcher.ts` — `launchOwnedAgentSync()` is the primary entry (normal
  synchronous spawn of the detached bridge using prebuilt binaries); the
  compatibility `launchOwnedAgent()` wrapper prepares binaries
  asynchronously. Both return `{ pid, process, exited, stop() }` shaped
  for spawn.ts-style integration (stdio pipes behave like a normal
  sub-agent process), and `stop()` orders the durable cancel marker
  before any signal.
- `native/owned-launch-common.h` — shared primitives: private ABI structs,
  boot identity, atomic durable writes, strict spec parser, coalition
  oracle, token acquisition, member enumeration.
- `native/owned-launch-bridge.c`, `native/owned-launch-supervisor.c`,
  `native/owned-launch-worker-gate.c`.

### Run directory artifacts

`spec.txt` (0600), `bridge.json`, `worker.json`, `owned.json` (the durable
journal), `release`, `cancel` (durable stop marker), `gate-handoff`,
`payload-exit.json`, `gate-exit.json` (failures only), `drain.json` (final
receipt: status/cause/boot/cid/sup_cid/started/exited/
esrch/signaled/iterations/mismatch/payload_code/at — written once,
truthfully, before any teardown), `retire.json` (job-retirement diagnostic,
only when a bootout stays unconfirmed), `job-supervisor.plist`,
`job-worker.plist`, `job.out`/`job.err`/`sup.out`/`sup.err`, plus the four
sockets (unlinked by the bridge on exit). Test-only barriers
`test-hold-pre-release` / `test-hold-before-retire` (and the
`test-hold-entered` acknowledgement) never exist in production runs: the
launcher creates the fresh 0700 UUID run dir empty.

### Bridge exit codes (integration contract)

- `0`–`255` actual payload exit status (natural completion only, after
  durable exit record and kernel-zero; reserved cancellation/fatal codes
  may coincide with payload codes);
- `125` fatal containment/startup failure (supervisor `fatal`, bootstrap
  failure, startup watchdog, bound overflow);
- `143` cancelled (parent stop/loss, supervisor `cancelled`);
- `10`–`16` immediate startup failures before any supervisor existed.

The bridge does not report success without a durable payload exit record.

## Test opt-in

`test/async-subagents/owned-launch/` — unit tests run everywhere;
launchd tests require `PI_OFFLINE_COALITION_PROBE=1` on macOS and only
create/clean their own UUID jobs, with an unrelated control process that
must survive every drain. The dangerous races are staged with the
deterministic `test-hold-*` barriers above (the supervisor acknowledges
with `test-hold-entered`; holds are bounded at 120 s). Test teardown never
removes a run directory before both UUID jobs are confirmed absent —
including on failure paths, where the directory is retained as evidence.

When the checkout is on a removable volume, run the opt-in matrix from an
internal-volume snapshot containing the source, fixtures, installed Pi, and
dependencies. Symlinks back to the checkout are not an isolated snapshot:
launchd helpers can still trigger macOS removable-volume permission dialogs.
Permission-blocked timeouts are inconclusive; do not disable macOS protections
or treat approving repeated dialogs as a reproducible test setup.

## Limits and claim boundaries

- **Fault model**: the 0700 run directory is the sole durable journal.
  External malicious deletion, rename, or corruption of that directory (or
  of `spec.txt` / `owned.json` inside it) is **outside the fault model** —
  it destroys the only drain obligation (a supervisor restart then has
  nothing to load or act on, and KeepAlive keeps restarting it). This is
  exactly why run directories must only be deleted after **both** per-run
  UUID jobs have been independently confirmed absent.
- Private ABI (`PROC_PIDCOALITIONINFO`, `PROC_PIDUNIQIDENTIFIERINFO`,
  `coalition_info_resource_usage` wrapper) copied/verified against XNU and
  host-observed; may drift across macOS releases. Fail-closed on any
  unexpected result.
- Coalition drain retries indefinitely while the job remains installed;
  `drainDeadlineSeconds` bounds each attempt. Persistent denial leaves
  `status=retry` and a live KeepAlive supervisor, never success.
- A capability-denied member (e.g. different uid after `sudo`) cannot be
  tokenized; KeepAlive retries instead of abandoning the member.
- Requires macOS with Xcode Command Line Tools for first build; missing
  toolchain fails closed (documented limit; no fallback path).
- Reboot durability: the journal is fsynced, but a reboot invalidates
  coalition ids by design (boot-bound journal ⇒ fatal, no signal).
- This candidate is **not G1/T3 acceptance**: draft runtime wiring exists,
  but real Pi/provider completion, timeout, force-stop, recovery, and
  concurrency/isolation verification remain open.
