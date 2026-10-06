# 0058 — Reverse navigation into Files

- Status: accepted
- Recorded: 2026-10-05
- Decided: 2026-10-05
- Owner / approval evidence: user confirmed IDE-style reverse navigation in this
  task's conversation; no separate durable approval artifact.
- Governing spec: [Workspace navigation](../../specs/desktop-workspace-navigation.md),
  [context menus](../../specs/desktop-context-menus.md),
  [Markdown rendering](../../specs/desktop-markdown-rendering.md)
- Replaces / replaced by: none

## Context

Relative folder links and Preview/editor tabs need a route back to their entries
in the project tree, like an IDE.

## Observations and sources

The existing Explorer owns lazy directory loading, selection and focus/scroll.
Preview tab metadata supplies trusted file paths to the generic native menu.
These are code observations, not claims of native UI acceptance.

## Decision

Use one Explorer reveal operation for both actions. Keep the project root,
clear Files search, expand parents, select and scroll/focus the target. Expand
directory targets too. Do not reopen the editor or modify its draft. Resolve
relative links from the workspace first, preserving Markdown's existing fallback.
Omit tab reveal for paths outside the workspace; retain existing Finder actions.

## Alternatives

Changing the Explorer root to the selected folder was explicitly excluded in
the user-confirmed interpretation. Reopening the file would unnecessarily touch
Preview navigation instead of providing reverse navigation.

## Consequences

Navigation preserves workspace context and editor drafts. Only the needed lazy
branch is loaded; asynchronous work requires replacement/workspace/teardown
guards. Outside-project files remain reachable through OS actions, not this tree.

## Revisit when

Explorer supports multiple roots, external files, or separate editor tabs.
