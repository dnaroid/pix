# 0054 — Project-shared LSP ownership

- Status: accepted
- Recorded: 2026-10-05
- Decided: 2026-10-05
- Owner / approval evidence: in this implementation conversation the user
  reported that per-tab language servers would be too expensive with many tabs,
  then approved the parent's proposal to share them per project, with global
  Start/Stop and closing one tab leaving the others working. Conversation-only
  evidence; no separate durable approval artifact or resource benchmark exists.
- Governing spec: [Project-shared LSP runtime and controls](../../specs/lsp-runtime-control.md)
- Replaces / replaced by: supersedes the session-ownership portion of
  [0052](0052-owned-lsp-control.md). Panel controls and idle policy superseded by
  [0056 — Monitoring-only LSP panels](0056-lsp-monitoring.md); project ownership remains accepted.

## Context

Desktop conversations and TUI instances run independent Pi processes. An
in-memory singleton in each process cannot reduce duplicated server processes
across tabs. The shared lifetime must not depend on the first tab remaining
open, and must still terminate owned processes when the last user disappears.
Lazy startup, trust gating, manual suppression and the existing panels remain.

## Observations and sources

- The prior [manager](../../external/pi-tools-suite/src/lsp/manager.ts) used a
  process-local singleton; the [ACP client](../../acp/src/pi/pi-rpc-client.ts)
  maintains a separate Pi runtime for each conversation.
- The existing [POSIX ownership regression](../../external/pi-tools-suite/test/lsp-process-owner.test.ts)
  exercises owner hard-kill and descendant cleanup. Keeping that guardian
  mechanism supplies a cleanup boundary below the new broker.
- [Configuration trust](../../specs/lsp-trust.md) is a caller-side permission to
  execute project configuration, not permission inferred from another tab's
  running server.
- Reported cost concern is user evidence, not a measured memory/CPU saving.
  Assumption: supported servers use stdio and do not intentionally escape their
  process group; independent tabs can share one document state per file.

## Decision

Use one local, OS-user-private project broker, shared across independent Pi
processes. Canonical project identity follows the nearest suite configuration
ancestor, otherwise Git ancestor, otherwise cwd. Identity discovery grants no
trust. Keep one server per ID/root within that broker, including nested roots.

Attach sessions without starting language servers. Connected IPC clients are
ownership leases. Closing or replacing one session releases only its lease;
the last lease triggers bounded teardown of the broker and owned descendants.
Broker lifetime must not be tied to its spawner's stdin or adapter process group.
Retain the per-server POSIX supervisor below the broker for crash cleanup.
Retain the broker's PID/inode ownership record until its process has exited;
recovery, not the exiting owner, removes the dead record. This prevents a
replacement from binding during the old broker's native socket teardown.

Evaluate configuration and trust in the requesting Pi process, send only an
approved serializable configuration snapshot, and never move SDK UI contexts
or trust prompts into the broker. Start/Stop/Restart and suppression are shared;
Trust once remains local to the requesting Pi process. Preserve cancellation
fences so a later Stop or teardown wins over an earlier pending Start/Restart.

Keep the private ACP command transport and existing panels. Explain explicitly
that controls affect the project and closing one tab does not stop others.
The selected IPC implementation is POSIX. Windows TUI retains the existing
session-local manager and taskkill cleanup with explicit narrower panel copy;
adding portable shared IPC is outside this macOS Desktop delivery, not grounds
for breaking the existing Windows TUI path.

## Alternatives

- Session-owned servers: preserves simpler crash ownership but retains the
  duplication the user rejected.
- A singleton only in the ACP process: does not cover separate Desktop windows
  and standalone TUI processes.
- Share a raw stdio server directly between clients: interleaves request IDs,
  initialization and document versions without one authoritative LSP client.
- Adopt external IDE servers or kill by process name: violates owned-process
  boundaries and risks unrelated applications.
- Permanently running service: unnecessary idle lifetime; selected broker is
  bounded by attached sessions instead.

## Consequences

Expected reduction in duplicate servers comes at the cost of one lightweight
broker per attached project, IPC, startup arbitration and last-client races.
Same-file edits must be serialized at the shared document owner. A Stop in one
tab intentionally affects every tab, so that scope must be visible in both UIs.
Different caller configurations/environments may disagree; requests must use
their own trust-approved configuration, not silently inherit another tab's
approval. A running ID/root retains its original configuration until Restart;
the broker uses its spawner's base environment plus approved server overlays.
Production bootstrap, stale endpoints and forced client exits need
independent-process regression evidence. No measured performance claim is made.

## Revisit when

The host offers a shared project service with equivalent crash ownership;
incompatible per-session settings require isolation; IPC or document contention
becomes measurable; or supported servers require process-group escape.
