# 0049 — Nonmodal model picker

- Status: accepted
- Recorded: 2026-10-05
- Decided: 2026-10-05
- Owner / approval evidence: user explicitly requested Model selection become a
  popup like the other status-bar controls (conversation-only evidence).
- Governing spec: [Desktop model picker popup](../../specs/desktop-model-picker-popup.md)
- Replaces: the Model + Thinking modal exception in
  [Desktop modal dialogs](../../specs/desktop-modal-dialogs.md); extends
  [0048 — Status-bar click popups](0048-status-bar-click-popups.md).

## Context

Status-bar details already use click-toggled nonmodal surfaces. Model + Thinking
still opened a blocking fullscreen native modal, contrary to the user's newly
requested consistency.

## Observations and sources

The old component called `activateModalDialog` and used a fullscreen backdrop.
Its search, staged Apply, default saving and visibility-management logic are
independent of modality. Native UI verification is not implied by these source
observations.

## Decision

Use a bounded native nonmodal dialog above the model button, retaining search
and all configuration semantics. Dismiss with repeat activation, Escape, outside
interaction or focus leaving its region. Escape/Cancel restore trigger focus;
successful Apply restores composer focus; outside dismissal preserves the
destination. Guard cancelled opening requests and late Apply completion.

## Alternatives

- Keep the modal: conflicts with the explicit consistency request.
- Immediately apply each row click: would change staged selection semantics,
  which the user did not request.
- Mount the entire selector inside the shared small details component: would
  entangle session-owned async configuration state with a local details toggle.
  Keep existing ownership and extract popup lifecycle/positioning instead.

## Consequences

The workbench remains interactive. Dismissal no longer implies composer focus
restoration and does not abort already-submitted configuration requests.
Nonmodal access makes stale completions more exposed, so ownership guards and
deterministic lifecycle tests are required. Other modal dialogs are unchanged.

## Revisit when

Native keyboard or narrow-window testing reveals clipped controls, unwanted
focus restoration, or interaction conflicts with other status popups.
