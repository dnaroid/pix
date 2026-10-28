# 0026 — Cross-instance Project Explorer clipboard

- Status: accepted
- Recorded: 2026-10-03
- Decided: 2026-10-03
- Owner / approval evidence: coding assistant implementation choice for the user's
  request to copy files/folders between Pix instances; format details were not
  separately prescribed by the user.
- Governing spec: [Desktop workspace navigation](../desktop/workbench/desktop-workspace-navigation.md)
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
Assumption/scope: Pix references address the same local macOS filesystem.
Cross-machine transfer was not requested.

## Decision

Use a bounded, versioned JSON reference on the system clipboard. Native macOS
Copy writes Finder-readable file URLs for each selected entry and puts the Pix
reference on the first item as both a private type and plain text, in one
pasteboard transaction. Reads prioritize the private Pix reference, preserving
its source workspace; legacy text-only Pix references remain supported. Cut
remains text-only Pix move data. Read only when opening a file menu or invoking
Paste; reread at activation to avoid stale copies. Copy snapshots the pasteboard
change count before filesystem validation and checks it again before committing;
a newer Copy or clipboard write makes the late operation fail recoverably rather
than replacing newer contents. Allow a source workspace distinct from the
receiving workspace, with
independent backend validation and canonical recursion checks. Keep existing
non-conflicting naming and reject concurrent target claims through exclusive
creation, cleaning up only targets created by this operation. On macOS, an
action-triggered pasteboard snapshot also adapts Finder-only local file-URL items
into a version-2 copy batch rooted at `/`; it reads URLs on the main thread,
validates filesystem metadata on a blocking worker and never writes back to the
pasteboard. Ordinary text paths remain invalid. Bound input
for native Copy and Finder imports to 1..1000 entries and 32768 encoded bytes;
native source trees inside the workspace are reserved along with destinations.

## Alternatives

- App-local shared state would cover windows in one process but not independent
  instances or a closed source window.
- Treat ordinary clipboard text as filesystem paths; rejected to avoid broad
  filesystem import from arbitrary text.

## Consequences

Pix clipboard contents are references, not content snapshots. Pix Copy replaces
ordinary text clipboard contents with Pix JSON, which other apps may paste as
text; Finder Paste instead reads file URLs without rewriting the clipboard.
Desktop gains clipboard read access used only for explicit file-panel actions.
Missing sources fail visibly. No broad filesystem import from arbitrary plain
text paths is introduced. Existing batch copy/history provides recursive copy,
collision-free naming and Undo/Redo; unsafe sources/destinations and concurrent
destination claims fail safely rather than overwriting.

## Revisit when

Finder cut/move or cross-machine transfer becomes a product requirement, or
clipboard format/version compatibility changes.
