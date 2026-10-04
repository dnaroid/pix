# 0028 — Scoped file-operation reservations

- Status: accepted
- Recorded: 2026-10-04
- Decided: 2026-10-04
- Owner / approval evidence: coding assistant implementation choice for the user's
  report that long file operations disable other Files commands. The user clarified
  that the rest of the application remains responsive; reservation details were
  not separately prescribed.
- Governing spec: [Desktop workspace navigation](../../specs/desktop-workspace-navigation.md)
- Replaces / replaced by: none

## Context

Files used one global busy flag. A large folder deletion prohibited even unrelated
mutations and clipboard commands until completion. We need to permit independent
work without permitting a rename/delete to invalidate another operation's source
or destination.

## Observations and sources

Native create, rename, copy and delete already use `run_blocking` in
`desktop/src-tauri/src/lib.rs`. The frontend busy flag and shared operation generation
were in `ProjectExplorer.svelte`. The reported symptom is command unavailability,
not a measured main-thread stall. Real Desktop reproduction was not completed;
no runtime responsiveness measurement is claimed. Deterministic reservation and
deferred-completion checks live in `project-explorer-operations.test.ts`.

## Decision

Use component-owned operation tokens with symmetric path conflict checks. Tree
claims exclude overlapping ancestors/descendants; shared directory claims keep
an ancestor alive without excluding sibling creations/deletions. Clipboard-only
commands need no path claims. Dispose all tokens on workspace replacement or
component teardown; each completion releases only its own token.

Copy/duplicate reserve the entire destination subtree until completion, since
the native command selects the output name and partial targets may become visible
to polling. This intentionally limits concurrency when copying into the workspace
root. These reservations are panel-local, not cross-window filesystem locks;
existing native validation and exclusive copy creation remain authoritative.
Close naming dialogs once the decision is submitted, and show background operation
labels/counts and errors in Files instead of keeping a progress modal open.

## Alternatives

- Keep global serialization: safe but preserves the user's reported problem.
- Remove all frontend locking: permits deletion of a source or partially copied
  destination during another mutation.
- Add a native target-reservation/progress protocol: could allow narrower copy
  locks but is outside this bounded frontend command-availability fix.

## Consequences

Independent deletions, renames and creations can run concurrently. Locks remain
conservative for copies; cross-window operations still depend on native safeguards.
Create/rename failures appear outside the now-closed naming dialog. No operation
cancellation or progress percentage is introduced, and invalidating UI tokens
does not cancel filesystem work already running.

## Revisit when

Root-destination copy concurrency, cross-window serialization, cancellation,
or precise native progress/target reservation becomes a product requirement.
