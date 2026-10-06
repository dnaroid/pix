# 0056 — Monitoring-only LSP panels

- Status: accepted
- Recorded: 2026-10-05
- Decided: 2026-10-05
- Owner / approval evidence: the user corrected the earlier panel interpretation:
  it should show active/reusable processes, not every matching configuration,
  and explicitly requested monitoring only, with edits starting LSPs and window/
  TUI closure stopping them. Evidence is this implementation conversation.
- Governing spec: [Project-shared LSP monitoring](../../specs/lsp-runtime-control.md)
- Replaces / replaced by: supersedes the panel/control and idle-cleanup policy in
  [0052](0052-owned-lsp-control.md) and [0054](0054-project-shared-lsp.md);
  project sharing, trust, transport and crash supervision remain unchanged.
  Its unlimited idle-retention policy is superseded by
  [0057](0057-lsp-reuse-idle-cleanup.md); monitoring-only panels remain active.

## Context and evidence

The previous snapshots synthesized stopped rows from matching configuration,
and both panels offered manual Start/Stop/Restart/Trust. This implemented a
configuration/control catalogue, not the requested process monitor. The manager
also scheduled shutdown after thirty idle seconds, losing reusable processes
before window/TUI closure. These are source observations, not usage benchmarks.

## Decision and scope

Desktop and TUI display actual starting/running/stopping runtime processes,
including idle running servers. Failed attempts without a reusable process are
warnings. Remove all panel mutation actions and reject them at the private ACP/
TUI command boundary; keep the existing transport name for status compatibility.
Keep internal lifecycle helpers and their race regressions, not as public controls.

Preserve edit-triggered lazy startup and existing file-based LSP tool acquisition.
Remove manager inactivity shutdown. Last connected project session closes the
shared runtime; closing the monitor or one of several owners does not. Windows
TUI keeps its session-local lifetime. Trust remains on the execution path and
monitoring never grants it or opens a trust dialog.
Repeated SDK binding for the same session/project retains ownership; replacement
still fences stale session work. SDK 1.0.3 `bindExtensions` emits `session_start`
on every binding, so treating every event as replacement would kill the sole
owner's processes while its window/TUI remains open.

## Alternatives

- Keep stopped configuration rows and hide buttons: still confuses configured
  capability with an actual reusable process.
- Keep idle teardown: contradicts reuse until owner closure.
- Adopt external IDE processes or a permanent daemon: changes ownership scope
  without user approval.

## Consequences and assumptions

Longer idle process retention consumes memory until the last owner closes; no
measured resource-cost claim is made. Process exit/failure remains possible and
is not prevented by lifetime ownership. Existing non-daemonizing stdio and POSIX
guardian assumptions remain. Older clients attempting mutations receive errors
and must reconnect/reload for the new monitor. Native close consent is unchanged.

## Revisit when

Measured idle resource use motivates an explicitly approved retention policy,
or the user requests separate configuration management rather than monitoring.
