# 0052 — Owned LSP control in Desktop and TUI

- Status: superseded
- Recorded: 2026-10-05
- Decided: 2026-10-05
- Owner / approval evidence: user requested controlled LSP ownership, a Desktop
  panel, preserved lazy edit-triggered startup, then explicitly requested the
  same mode and panel in TUI in this implementation conversation. The parent
  chose the supervisor and shared runtime protocol to satisfy those requirements;
  no separate user approval of implementation internals is claimed.
- Governing spec: [Owned LSP runtime and controls](../../specs/lsp-runtime-control.md)
- Replaces / replaced by: session ownership superseded by
  [0054 — Project-shared LSP ownership](0054-project-shared-lsp.md). Lazy startup,
  trust, private transport and per-server supervision remain applicable.
  Panel controls and idle policy are superseded by
  [0056 — Monitoring-only LSP panels](0056-lsp-monitoring.md).

## Context

Language servers must not outlive their owning Pix window/runtime. Users also
need visible state and manual controls, without making startup eager or trusting
project configuration implicitly. Desktop and TUI must share runtime semantics.

## Observations and sources

- [Native process lifecycle](../../specs/desktop-native-process-lifecycle.md)
  includes bounded teardown and force-killing the adapter group. JS exit hooks
  alone cannot clean detached LSP groups after SIGKILL.
- [Ownership regression](../../external/pi-tools-suite/test/lsp-process-owner.test.ts)
  directly exercises owner hard-kill with a stubborn descendant on POSIX.
- [Trust](../../specs/lsp-trust.md) protects project-local configuration; global
  configuration is user-owned. Status must not turn that gate into an execution
  side effect.
- User requirements above are conversation-only evidence, not a separate
  durable approval artifact. Assumption/limit: supported LSPs communicate over
  stdio and do not intentionally daemonize out of the owned process group.

## Decision

Keep edit-triggered lazy startup. Share status/start/stop/restart/trust controls
between a Desktop sidebar and `/lsp` TUI custom component. Stop suppresses lazy
restart until explicit Start/Restart. Trust is a separate no-spawn action.

Keep session-owned root/control records separate from live processes: idle
cleanup preserves failed errors and manual Stop, whereas session replacement
resets them. Retained nested roots are revalidated against trusted configuration
before Start/Restart; Stop alone cannot register an unknown root. This avoids
stranding a lazily discovered nested server after stopping it.

On POSIX, run each server under a detached Node supervisor with the server and
ordinary descendants in that group. Use the LSP input pipe itself as owner
liveness: EOF sweeps the group even after Pi is force-killed. Use a separate
descriptor only for actual server PID metadata, not liveness. Windows retains
normal taskkill process-tree cleanup; macOS is the only Desktop target.

Use ACP/private correlated command transport rather than a model tool or user
conversation message. Emit snapshots through the SDK session event stream:
its RPC output guard redirects ordinary stdout writes to stderr, so a direct
write loses the snapshot even though the command acknowledgement succeeds.
TUI trust dismisses the panel before opening the normal trust dialog to avoid
competing custom-UI ownership.

## Alternatives

- Exit hooks only: insufficient for native force-kill or parent crashes.
- Put servers directly in the adapter group: does not supply the same standalone
  TUI ownership mechanism and loses independent graceful control boundaries.
- Separate liveness descriptor: rejected after unstable Bun proxy experiments;
  stdio input EOF is the chosen ownership channel. No general runtime benchmark
  claim follows from those experiments.
- Eager/shared daemon or kill-all-by-name: violates lazy startup and risks
  unrelated IDE processes.
- Independent Desktop/TUI managers: duplicates trust/lifecycle policy.

## Consequences

One extra lightweight supervisor per POSIX LSP is the cost of crash ownership.
Polling and RPC correlation add bounded UI resources and require stale-completion
guards. Process-group cleanup cannot capture children that intentionally escape
the group. Windows hard-kill ownership remains outside the POSIX guarantee.

## Revisit when

The SDK/native host supplies equivalent portable owned-process primitives;
supported servers require daemonization; Windows crash ownership becomes a
product requirement; or measured supervisor overhead/stdio compatibility issues
justify replacing this design.
