---
kind: spec
status: active
---

# TUI workspace tools

## Behavior

Pix TUI exposes four workspace-scoped tools from dedicated status-bar icon
buttons: Tasks, Registry, IDX, and Settings. Each button opens one centered modal
that occupies nearly the full available conversation viewport while leaving the
status bar visible. Only one workspace tool modal may be open at a time.
Selecting the active tool closes it, selecting another tool switches directly to
that tool, and Escape closes the modal when the active surface is not consuming
Escape for an editor or confirmation state.

Workspace tool modals are modal with respect to the conversation and composer.
While a tool is open, its keyboard and mouse handling takes precedence over
extension/editor input and underlying conversation or input-scroll interactions.
The four status-bar buttons remain usable so the user can switch tools directly.
The modal close affordance dismisses only when its close target is activated.

The primary interaction model inside workspace tool modals is mouse-oriented.
User actions are rendered as explicit bracketed buttons or clickable entity rows
with bounded hit targets. Selecting a task or Registry resource exposes its
relevant action buttons. Text settings and query/configuration fields may still
require typing, but field selection, save/cancel, toggles, refresh, maintenance,
and destructive confirmations are all available by mouse. Keyboard shortcuts
remain fallback controls and are not required for normal navigation or actions.

The supported tools are intentionally limited to:

- Tasks: read and explicitly mutate project `.pi/tasks.jsonc`, including
  create/edit/status/type/reorder/delete and running the selected task through
  the normal TUI prompt path. Task rows are clickable and the selected task shows
  explicit Run, Edit, status/type, reorder, and delete controls.
- Registry: inspect and explicitly act on the resource registry, including
  reusable resources and project state. Resource rows are clickable; primary and
  destructive actions are exposed as buttons, with destructive actions requiring
  a separate confirmation click.
- IDX: inspect repository index state and run user-requested query or maintenance
  commands through visible Refresh, Initialize, Index, Reindex, Dry run, Doctor,
  query-mode, query-edit, and query-run controls.
- Settings: inspect and edit TUI Pix configuration and supported pi-tools-suite
  settings. Each supported setting is a clickable edit/toggle button; text edits
  expose explicit Save and Cancel controls.

Git, project file browsing, and package-script launching are not workspace tool
modals.

## Constraints and failure cases

Workspace tools do no background polling, watching, indicator refresh,
automatic Registry synchronization, or hidden maintenance. Opening a tool may
perform one foreground load. A user-requested mutation or maintenance operation
may perform the operation and one directly linked refresh before becoming idle
again.

Foreground operations that must remain observable may temporarily refuse modal
close or tool switching until they complete. Async loads must ignore stale
completion after the surface is closed or replaced. Registry commands run in a
disposable no-session runtime and that runtime is disposed when the command
finishes. IDX work is process-bound to the explicit foreground action and does
not leave a periodic refresh loop behind.

On narrow terminals the normal status-line fitting rules may hide right-side
widgets when they cannot fit. The modal itself degrades toward full-screen while
preserving a small terminal margin when space allows.

## Implementation

- `src/app/workspace-tools/workspace-tool-controller.ts::WorkspaceToolController`
- `src/app/workspace-tools/workspace-tool-renderer.ts::renderWorkspaceToolModal`
- `src/app/workspace-tools/tasks-surface.ts::TasksWorkspaceToolSurface`
- `src/app/workspace-tools/registry-surface.ts::RegistryWorkspaceToolSurface`
- `src/app/workspace-tools/registry-command-runner.ts::runRegistryCommandForeground`
- `src/app/workspace-tools/idx-surface.ts::IdxWorkspaceToolSurface`
- `src/app/workspace-tools/settings-surface.ts::SettingsWorkspaceToolSurface`
- `src/app/rendering/status-line-renderer.ts::StatusLineRenderer`
- `src/app/rendering/render-controller.ts::AppRenderController`
- `src/app/input/input-controller.ts::AppInputController`
- `src/app/screen/mouse-controller.ts::AppMouseController`

## Tests

- `tests/workspace-tool-controller.test.ts`
- `tests/workspace-tool-renderer.test.ts`
- `tests/tasks-surface.test.ts`
- `tests/registry-surface.test.ts`
- `tests/idx-surface.test.ts`
- `tests/settings-surface.test.ts`
- `tests/status-controller.test.ts`

## Verification

The focused workspace-tool tests and TypeScript check must pass. Repository-wide
test failures that predate or belong to unrelated working-tree changes should be
reported separately rather than fixed opportunistically. Task-scoped knowledge
audit should not identify an older spec that contradicts this TUI-only behavior.
