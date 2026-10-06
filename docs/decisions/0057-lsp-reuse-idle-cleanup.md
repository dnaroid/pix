# 0057 — Canonical LSP reuse and bounded idle retention

- Status: accepted
- Recorded: 2026-10-05
- Decided: 2026-10-05
- Owner / approval evidence: user approved preserving separate package workspaces and a 15-minute idle timeout in this implementation conversation
- Governing spec: [LSP runtime monitoring](../../specs/lsp-runtime-control.md)
- Replaces / replaced by: supersedes the unlimited idle-retention portion of [0056](0056-lsp-monitoring.md); its monitoring-only UI decision remains active

## Context and evidence

The user requested generic duplicate prevention for current and future LSPs,
without collapsing legitimate distinct package workspaces. They then requested
cheap automatic cleanup that works with the monitoring panel closed and selected
15 minutes. Keeping all edit-started processes until the final owner leaves is
therefore no longer the desired retention policy.

Source observations: local acquisition previously accepted physical-path aliases
as distinct roots, although the IPC broker already canonicalized roots. Replacing
an unavailable client could bypass its still-live process teardown. Acquisition,
requests and diagnostics run in the owning manager/client independently of panels;
this is the coordination point for attached owners and the Windows local fallback.
Deterministic tests use a manual clock to cover aliases, concurrent retries,
cancellation, owner shutdown, overlapping requests and timer callbacks.

Assumption: time since the last completed Pix operation is an adequate proxy for
whether a server is worth retaining. We do not infer need from CPU load, editor
visibility or unsolicited language-server background traffic.

## Decision and scope

1. Reuse one process per configured server ID and canonical physical language
   workspace. Canonicalize local file/cwd/root identity, not just IPC identity.
   Different IDs and real separate package roots remain independent.
2. Await old-client teardown before replacement and recheck ownership,
   cancellation and stop fences before spawning. Concurrent startup is shared.
3. Retire a server after 15 minutes without a Pix edit or LSP request, counted
   from completion of its last operation. Startup and overlapping operations
   hold activity guards. Status and cached diagnostics do not extend retention.
4. Use a resettable unreferenced timer per idle server, owned by the manager.
   No process/CPU polling and no dependency on an open panel. Clear timers on
   teardown; stale cancelled callbacks cannot retire new work.
5. Keep an idle-closing client registered until teardown finishes so a new
   acquisition cannot overlap it. The next edit/request then lazily starts it.
   Last-owner departure still shuts everything down immediately.

## Alternatives considered

- One process per server ID globally: conflates legitimate package workspaces.
- Unlimited retention: preserves warmth but retains unused processes indefinitely.
- UI polling or CPU-based detection: unnecessary overhead and panel-dependent
  ownership; CPU activity is not a reliable indicator of Pix demand.
- Close after a fixed interval even during a request: can interrupt useful work.

## Consequences

Long-idle work pays a cold-start cost on its next operation. Generic identity and
activity tracking apply to future configured LSPs without per-language rules.
Servers can perform background work while considered idle; only Pix operations
extend retention. Closing a panel neither cancels nor resets an idle timer.

## Revisit triggers

Revisit if measured restart cost warrants a different timeout or configuration,
if future long-lived operations need explicit activity guards, or if a server's
workspace semantics cannot be represented by configured root markers.
