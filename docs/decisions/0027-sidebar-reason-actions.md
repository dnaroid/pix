# 0027 — Cause-specific sidebar quick actions

- Status: accepted
- Recorded: 2026-10-04
- Decided: 2026-10-04
- Owner / approval evidence: user clarified and approved cause-specific dot actions in this task conversation; no separate durable discussion artifact.
- Governing spec: [Desktop sidebar indicators](../../specs/desktop-sidebar-indicators.md)
- Replaces / replaced by: none; extends [0025](0025-sidebar-health-polling.md) without changing polling.

## Context

The Activity Bar shows one strongest health dot, but several causes may be active.
The user rejected generic per-section menus: dirty knowledge should offer AI review,
and other causes should offer their own relevant actions.

## Observations and sources

Verified: the [indicator policy](../../desktop/src/lib/sidebar-indicator-policy.ts)
already enumerates causes; existing owners expose AI review, Git, task and Registry
callbacks. IDX operation state remains owned by its mounted panel. The existing
Project Explorer uses a component-owned WebView menu and shared keyboard helpers.
Native visual verification is separate from deterministic tests, not assumed here.

## Decision

Retain all current causes with stable reason IDs while preserving the existing
strongest-dot/tooltip contract. Offer a component-owned menu only when causes exist,
grouping commands by cause rather than parsing tooltip text. Reuse existing command
owners and capability guards; inspection reveals existing controls without toggling
them closed. In particular, stale-index maintenance reveals IDX controls instead of
automatically starting an index operation; dirty knowledge invokes AI review.

Recheck workspace, cause and eligibility at activation. Close the menu on context
loss and teardown; keep keyboard navigation/typeahead consistent with other menus.
Background polling remains read-only; opening a menu never acknowledges knowledge.

## Alternatives

- Generic section menus: rejected by the user because they do not address the dot.
- Only the strongest cause: hides actionable lower-priority concurrent causes.
- Parse tooltip text: couples behavior to copy and loses stable command identity.
- Lift IDX operation state into the sidebar: unnecessary ownership expansion for a
  maintenance-navigation command; existing controls retain operation safeguards.

## Consequences

### Dirty Git combined command (2026-10-04)

The user explicitly requested and confirmed a one-click equivalent of
**Stage all & generate → Commit & push** in the dirty Git dot menu. It therefore
stages every change, rather than preserving the composer Generate convention
of keeping an existing partial staging selection. The menu label states both
the all-files scope and AI use. The Git store owns one serialized transaction;
the assistant supplies only message generation. Existing manual composer paths
remain unchanged. Failures stop subsequent steps; failed publication preserves
the local commit for Retry Push. This extends the existing command-owner and
eligibility decision, not an automatic polling side effect.

An alternative requiring a second composer click was rejected for this command
because it would not satisfy the confirmed one-click request. Revisit if the
product adds explicit per-file scope selection to sidebar actions.

#### Panel-independent execution (2026-10-04)

The user reported that eligibility depended on opening Source Control first and
requested that executing the command not open the panel. The full Git store is
lazy; the sidebar's dirty reason already comes from its independent health poll.
Treat an unloaded full snapshot as pending validation for this self-refreshing
command only, retain known safety/busy/AI guards, and require a successful fresh
status checkpoint before staging. Manual Push still requires a loaded snapshot.
The command leaves panel selection/collapse unchanged; Source Control remains
available for detailed progress/errors. Requiring a panel visit or eagerly loading
full Git status on every sidebar poll was rejected as unnecessary coupling/work.

The user then extended the no-panel-opening rule to all work commands. Reload,
retry, Fetch, Push and AI actions leave sidebar selection/collapse unchanged;
explicit inspection/navigation still reveals its destination. Project retry must
therefore recheck the root independently while the explorer is absent, rather
than merely bumping a key on an unmounted component. Mounted tree reloads keep
their existing owner. Background retry results are workspace/generation/teardown
guarded. This changes execution/navigation coupling, not the polling schedule.

Commands remain small and use existing workflows. Some actions navigate to controls
instead of performing work immediately. Cause mappings and enabled guards must stay
in sync with command owners; activation and lifecycle tests cover stale contexts.

## Revisit when

New indicator causes or command-owner eligibility rules are introduced, native QA
finds focus/menu conflicts, or users need a dedicated safe immediate maintenance
command rather than navigation to IDX controls.
