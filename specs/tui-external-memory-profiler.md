---
kind: spec
status: active
---

# External TUI memory/freeze profiler

## Behavior

This opt-in, source-checkout-only macOS launcher runs Pix normally with inherited
terminal I/O and polls its RSS from a separate Node process. It does not change
autocomplete, session contents, rendering, or Desktop behavior. It is diagnostic
instrumentation, **not a fix or a confirmed explanation** for the reported TUI
9 GiB typing incident. The user also reported frequent TUI freezes but no Desktop
freezes; that narrows investigation, not proof of a particular cause.

From the repository root (existing Pix `dist/` must be built):

```sh
node scripts/profile-pix-memory.mjs -- --session /path/to/session.jsonl
```

Pix arguments are passed verbatim after `--`. Optional profiler arguments before
the separator are `--threshold-mb N` (default 1024, allowed 64–65536) and
`--output DIR` (a parent directory, never an existing report to overwrite).

The profiler writes one RSS sample per completed poll (nominally every second),
up to 3600 samples. At the first sample above the threshold it collects a
one-second macOS `sample` and `vmmap -summary`. A freeze with low RSS can be
captured from another terminal using the **profiler**, not Pix, PID printed at
startup:

```sh
kill -USR1 <profiler-PID>
```

Manual requests coalesce; automatic and manual captures share a two-capture
budget. Samples, capture tools, and file writes are serialized; no polling/log
backlog accumulates. Child exit aborts active polling/tools and releases signal
handlers. SIGINT/SIGTERM sent to the profiler are forwarded once to Pix; Pix owns
normal terminal restoration. The launcher preserves Pix's exit code (or the
usual 128 + signal number for signal exits).

If Pix is blocked and cannot honor termination, the profiler deliberately remains
alive and can still collect evidence. It does not escalate to SIGKILL or claim
successful terminal restoration. Startup prints both PIDs; explicitly killing
the Pix PID ends that run when necessary (after evidence collection).

## Constraints and failure cases

- macOS only; requires `/bin/ps`, `/usr/bin/sample`, and `/usr/bin/vmmap` and
  permission to inspect the owned child process. Tools may fail due to permissions
  or a process exiting; capture output includes the failure rather than implying
  a usable profile.
- An in-process watchdog can stop running when Pix's event loop is blocked.
  External RSS/stack inspection does not require that loop to service a timer.
  It still depends on the OS and may miss spikes between polls. Polling pauses
  during captures (each tool has a five-second timeout and 2 MiB output bound).
- RSS alone does not distinguish JS heap, native allocations, or transient
  formatting work. Stack/maps are clues, not guaranteed JS allocation attribution;
  no external V8 heap snapshot is claimed.
- The sample count/capture budget bounds disk use; after the sample limit Pix
  continues running, but no further measurements/captures occur. Diagnosing a
  later incident requires another profiled run.
- Diagnostic failures must not kill Pix. A failed RSS/log operation stops
  monitoring with a visible error; the child remains usable until its normal
  exit. Summary metadata records errors when the filesystem permits it.
- Reports default to `~/.config/pi/memory-profiles/<timestamp>-<profiler-PID>/`.
  New report directories use mode 0700 and files mode 0600. `run.json`,
  `rss.jsonl`, numbered `sample`/`vmmap` files and `summary.json` may contain
  sensitive paths/process details; inspect and redact before sharing.
  `captureAttempts` counts started attempts, not usable profiles; `capture-start`
  without `capture-finished` can indicate an interrupted capture with no files.
- This adds no always-on overhead and is not shipped as a global `pix` CLI flag.
  [Existing thinking-stream fix and internal watchdog](tui-streaming-thinking-memory.md)
  remain independent. Autocomplete settings are not modified by this launcher.

Design rationale: [0004 — External TUI incident profiling](../docs/decisions/0004-external-tui-incident-profiling.md).

## Implementation

- `scripts/profile-pix-memory.mjs`
- `scripts/pix-memory-profiler.mjs`

## Tests

- `tests/pix-memory-profiler.test.ts`

## Verification

Run `node --import tsx --test tests/pix-memory-profiler.test.ts` for deterministic
RSS parsing, argument boundaries, sample/capture limits, serialized work,
shutdown during an in-flight measurement/write/capture, and surfaced I/O errors.
The same tests cover fast child exit/spawn failure during startup report I/O,
monitor-only signal forwarding, ignored/delayed termination, and listener cleanup.

A real TUI soak must separately measure RSS while typing after the answer has
finished, and retain stack/maps for a recurrence. Short typing smoke tests or
offline editor loops do not establish that the leak/freeze is eliminated.
