---
kind: spec
status: active
---

# Opt-in TUI incident trace

## Behavior

On macOS, `PIX_MEMORY_TRACE=1 pix` enables temporary diagnostics in normal TUI
startup (the existing memory watchdog must remain enabled). No wrapper or global
configuration edit is needed. Unset the variable to return to normal diagnostics.
Other platforms do not start this trace.

An independent child samples TUI RSS with `/bin/ps` once per second, for at most
3,600 samples. Once per second the main process sends JS memory metrics and
numeric/boolean app counters, including draft length/revision/image count. There
is at most one outstanding heartbeat. Draft text, messages, session IDs, secrets
and arbitrary host objects are excluded.

The monitor captures macOS stack/maps at the first RSS crossing of the lesser of
the watchdog threshold and 1,024 MiB (minimum 64 MiB), or when the main-thread
heartbeat is at least ten seconds old. There are at most two captures, serial and
coalesced as in the [external profiler](tui-external-memory-profiler.md). A stall
is a diagnostic trigger, not proof of a leak: GC/other blocking work can cause it.
The monitor remains operational when the TUI event loop is blocked.

V8 allocation sampling uses a 512 KiB interval. Every 30 successful heartbeats,
the main process saves a Chrome-compatible `.heapprofile`, rotating three files
with an 8 MiB output limit each. These are sampled live allocations, not full
snapshots, and omit allocations predating startup. Normal watchdog reports remain,
but this mode skips synchronous full heap snapshots to avoid amplifying a freeze.

Files are under `~/.config/pi/memory-traces/<timestamp>-<TUI pid>/`:

- `run.json`: PID/monitor PID, Node version, threshold;
- `trace.jsonl`: external RSS, heartbeat age and latest main-thread metrics;
- `allocations-{0,1,2}.heapprofile`: sampled allocation profiles;
- bounded stack/map capture files and `summary.json` from the shared collector.

`memory.trace_started` in `~/.config/pi/pix.log` records the directory. Directories
are created with mode 0700, files with 0600. Function/source paths occur in profiles
and OS captures; review evidence before sharing. Old run directories are not
automatically deleted.

## Constraints and failure cases

- This opt-in adds polling/profiling overhead; it is not always-on telemetry or
  a confirmed fix for the reported post-answer typing growth.
- During a freeze JS metrics/profiles become stale; external RSS/stack/maps
  continue. Profiles may be absent before the first interval or on inspector error.
- Collector limits apply: 3,600 samples, two captures, tool timeouts/output caps.
  Interrupted captures can be partial; capture attempts are not successes.
- Shutdown cancels timers, disconnects inspector/IPC and aborts owned OS tools.
  Abrupt parent exit disconnects IPC too. Unref'd worker/channel/timers cannot
  keep Pix alive. Profile writes receive an abort signal; cancellation before
  publication skips rename and removes the temporary file. A rename already in
  flight can finish; late inspector callbacks cannot initiate a write. Worker
  exit/error stops sampling.
- Diagnostic failures do not intentionally crash Pix. Limits are per run, not
  global; users remove old directories. V8 retains sampled live-allocation
  metadata while enabled; a pathological call tree may warrant a tighter bound
  than sampling interval and one-hour monitor lifetime.

Decision: [0006 — Embedded opt-in TUI incident trace](../docs/decisions/0006-embedded-tui-incident-trace.md).

## Implementation

- `src/app/diagnostics/tui-memory-trace.ts`
- `src/app/diagnostics/tui-memory-trace-worker.ts`
- `src/app/diagnostics/memory-watchdog.ts`
- `src/app/app.ts`
- `scripts/pix-memory-profiler.mjs`
- `scripts/profile-pix-memory.mjs`
- `package.json`

## Tests

- `tests/tui-memory-trace.test.ts`
- `tests/memory-watchdog.test.ts`
- `tests/pix-memory-profiler.test.ts`

## Verification

Run focused tests and `npm run build:pix`. A non-UI blocked Node component can
verify independent OS collection, but cannot establish TUI leak reproduction or
elimination. Real typing verification needs retained UI evidence and measured
RSS over time, not a help/startup smoke.
