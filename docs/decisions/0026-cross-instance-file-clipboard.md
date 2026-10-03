# 0026 — Cross-instance Project Explorer clipboard

- Status: accepted
- Recorded: 2026-10-03
- Decided: 2026-10-03
- Owner / approval evidence: coding assistant implementation choice for the user's
  request to copy files/folders between Pix instances; format details were not
  separately prescribed by the user.
- Governing spec: [Desktop workspace navigation](../../specs/desktop-workspace-navigation.md)
- Replaces / replaced by: none

## Context

Project Explorer previously kept its copied entry in mounted component state,
preventing other windows/processes from pasting it. The user requested copying
files and folders from one Pix instance to another in the file panel.

## Observations and sources

The existing Desktop clipboard plugin supports system text writes/reads;
the existing backend already validates workspace-relative entries and performs
recursive copying on a blocking worker. Evidence: `ProjectExplorer.svelte`,
`project-entry-clipboard.test.ts`, and native project-entry tests in `lib.rs`.
Assumption/scope: instances share the same local macOS filesystem. Cross-machine
transfer and Finder interoperability were not requested.

## Decision

Use a bounded, versioned JSON reference on the system text clipboard. Read only
when opening a file menu or invoking Paste; reread at activation to avoid stale
copies. Allow a source workspace distinct from the receiving workspace, with
independent backend validation and canonical recursion checks. Keep existing
non-conflicting naming and reject concurrent target claims through exclusive
creation, cleaning up only targets created by this operation.

## Alternatives

- App-local shared state would cover windows in one process but not independent
  instances or a closed source window.
- Native Finder file URLs could provide OS file-manager interoperability, but add
  platform-specific clipboard ownership/encoding beyond this bounded Pix-to-Pix
  request. Revisit if interoperability is requested.

## Consequences

Clipboard contents are a reference, not a content snapshot. Copy replaces ordinary
text clipboard contents with Pix JSON, which other apps may paste as text.
Desktop gains read-text permission, used only for explicit file-panel actions.
Missing sources fail visibly. No broad filesystem import from arbitrary plain
text paths is introduced. Concurrent destination claims fail safely rather than
overwriting; users may retry to obtain the next available name.

## Revisit when

Finder interoperability, multiple selection, cut/move or cross-machine transfer
becomes a product requirement, or clipboard format/version compatibility changes.
