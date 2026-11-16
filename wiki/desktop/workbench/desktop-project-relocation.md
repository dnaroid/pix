# Desktop project relocation

## Type

Change.

## Lifecycle

Active implemented contract.

## Goal

Keep a project's Pi sessions, tab snapshots and path-keyed Desktop state attached
to the project after its folder is renamed or moved outside Pix, instead of
treating the new path as a different project.

## Stable project identity

- `<workspace>/.pi/project-id` holds a UUID. It is created only when a real
  `.pi` directory already exists. Opening a workspace never creates `.pi` or
  this file.
- Desktop stores `pix.desktop.projectIdentities` in localStorage, mapping each
  project ID to the last known absolute path.

## Detection

- Selecting a recent project whose folder is missing shows **Project folder not
  found**. Its **Locate Folder…** action opens the folder picker. If the chosen
  folder's project ID differs from the recorded one, Desktop requires an extra
  confirmation before relocating.
- When an opened folder's ID was last recorded at a path that no longer exists,
  Desktop offers **Move Sessions** (dialog title **Project folder moved**).
- The same check runs at startup, after the initial connection, for the restored
  workspace.

## Relocation

Relocation runs only after the current workspace's sessions are closed.

1. Native command `relocate_project_state`
   (`desktop/src-tauri/src/project_relocation.rs`):
   - Moves Pi sessions from `<agentDir>/sessions/--<encoded cwd>--/` to the new
     encoded directory, rewriting each session header `cwd`. Timestamps are
     preserved.
   - Moves only `.jsonl` sessions whose header `cwd` equals the old path (the
     SDK directory encoding is lossy: `/a-b` and `/a/b` share a directory).
     Other files are left in place and reported as `skipped`.
   - Never overwrites. A conflicting session stays at the old location and is
     logged as a warning. If a session changes while it is being copied, the
     copy is discarded and the command fails, so retrying is safe.
   - Moves the TUI/queue tab snapshot `<agentDir>/pix/tabs/<hash>.json` and
     rewrites its paths.
   - Rewrites the moved sessions' records in the ACP session map
     (`~/.pi/agent/pix-acp/sessions.json` or `PIX_ACP_SESSION_MAP`). It holds
     the same `<file>.lock` directory lock that ACP uses, and ACP session IDs
     (and therefore Desktop tabs) are preserved.
   - Refuses to run while the old folder still exists, or while another Pix
     window still shows the old path.
2. Desktop (`desktop/src/app/project-relocation.ts`) then rewrites path-keyed
   localStorage: recent projects (in place), the workspace, model selection
   frequency, and per-window `activeSessions`, `sessionTabs` and
   `sessionTabModels`. State from the old path replaces the state that was
   created at the new path before relocation, such as an empty tab list
   written at startup.

`.pi/project-id` is kept by `.pi` cleanup. A copy of a project shares its ID,
but while the original folder exists its recorded path is not replaced.

If the native relocation fails, the folder still opens and the move is offered
again on a later open.

Not migrated: other open windows' in-memory state, and recomputable search
indexes.

## Related

- [Desktop project switcher and identity color](desktop-project-titlebar.md) — recent-project list and switching.
- [Desktop session tabs](../conversations/desktop-session-tabs.md) — tab snapshots that are rewritten.
- [Desktop Git workflows](../integrations/desktop-git-workflows.md) — `/.pi/` ignore rule written when Git is initialized.
- [Registry project state](../../work-management/registry/resource-registry-project-state.md) — `.pi` project state.

## Open questions

- The source material does not state whether `.pi/project-id` is committed,
  ignored by Git, or synchronized through Registry. This page does not specify it.

## Projects without a stable ID

When an opened folder has no recorded ID mapping, Desktop looks for exactly one
recent project with the same folder name whose path no longer exists and whose
recorded ID (if any) does not conflict. If found, it offers **Move Sessions**.
Several matches are never guessed (use **Locate Folder…**). Declined offers are
remembered in localStorage `pix.desktop.declinedProjectRelocations` (last 50
`from`→`to` pairs) and are not repeated; this applies to ID-based offers too.
