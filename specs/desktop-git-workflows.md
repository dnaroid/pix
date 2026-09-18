# Desktop Source Control workflows

<!-- markdownlint-disable MD013 -->

## Type

Change

## Lifecycle

Active implemented contract.

## Goal

Optimize Source Control for message generation → commit → push, code review → commit → push, and code review → a separate fix session. Keep ordinary Git operations available without giving them the same visual priority as the daily workflows.

## Primary workspace UI

The sidebar header shows the local branch, upstream, outgoing/incoming counts, status refresh and a standalone Push/Publish action. The branch selector also allows leaving detached HEAD. Incoming commits, conflicts, errors and completed operations have explicit feedback.

The commit composer remains outside the file-list scroller. It has visible Generate message, Code review, Commit and Commit & push controls. Commit & push is primary when pushing is available; Commit remains available for local work without a remote. Missing Git-assistant readiness disables only AI preparation, not manual Git operations or message editing. Git preparation uses the standalone assistant for the selected workspace and requires only a connected, ready ACP client and nonempty workspace; it does not create, load or depend on a conversation session. The Source Control view clamps its content pane to a 360 px minimum so these desktop actions keep their single-line labels and normal control spacing instead of compressing into a cramped layout.

Staged and working-tree changes retain file status, per-scope additions/deletions, individual stage/unstage, stage/unstage-all and diff inspection. A path filter narrows visible rows. Bulk actions still affect their entire scope, including filtered-out files, and their tooltips state this. The filter resets when the workspace changes.

## Preparation and commit semantics

- Generate message describes only the staged diff. With no staged files its label becomes **Stage all & generate**, explicitly adding all changed/untracked files before generation. Failure to stage stops the sequence. Existing partial staging is never silently expanded by Generate message or Commit.
- Code review targets staged changes when staging is nonempty, otherwise all changes. The scope is visible beside the commit-message label. Review all is also available independently. Reviewing never stages, commits or pushes.
- The message is an editable per-workspace draft. Edits persist immediately. A generated result cannot overwrite edits made while it was in flight or write into a disposed/workspace-replaced composer.
- Commit creates a local commit from the index. Commit & push is one explicitly requested, serialized commit-then-push transaction; a failed commit never starts push. A failed push after a successful commit reports partial success and instructs the user to retry Push rather than commit again. Only the submitted, unchanged draft is cleared after a successful local commit, including partial success.
- Ctrl/Cmd+Enter runs Commit & push when pushing is available, otherwise Commit locally. Ctrl/Cmd+Shift+Enter always commits locally. Disabled-state checks also apply to these shortcuts.
- Pushing is unavailable for detached HEAD, no configured remote, ambiguous publication targets or known incoming commits. Publication follows the existing backend selection rule: prefer origin, otherwise use the only remote. There is no force push. Existing local commits can be pushed without making another commit.

## Review checkpoint and fixing

The most recent review is workspace-owned, independent of the selected diff editor. Inspecting another file or closing/reopening the Git Diff tab does not discard its findings. A sidebar checkpoint exposes the result, scope, View action and **Fix in new session** when there are findings.

The editor has Review and Diff views. Review uses the full editor height with an independently scrolling findings body and a stable action header; it is no longer restricted to a small split above the diff. Completing a review does not switch somebody away from a manually selected Diff view. Copy prompt remains available with clipboard feedback, subject to the same stability guards.

Every review starts with a fresh backend diff, not a cached editor preview. After the model responds, the diff is rechecked. Status refresh also revalidates retained reviews. Workspace mutations invalidate reviews conservatively; changing staged scope requires review again for the fix-session handoff. A stale review remains readable but cannot start a fix session. Failed and empty reviews are not treated as actionable findings. Review is advisory, not a mandatory commit gate.

Fix in new session rechecks the reviewed diff immediately before allocating a session. It uses the existing runtime/session machinery to create and activate a distinct session with the review-resolution prompt. That prompt requires verifying findings against current files, preserving unrelated changes, adding relevant tests, and **not committing or pushing** without an explicit user request. A workspace switch during creation cleans up the unused session. Starting a fixing session invalidates the checkpoint to prevent repeated handoff of the same snapshot.

LLM results and Git mutation completions are bound to their originating workspace lifecycle. An A → B → A workspace switch does not authorize a completion from the first A lifecycle to overwrite data or release locks in the second. Staged-diff changes during message generation cause the generated result to be rejected.

## Secondary repository tools

Repository tools is a keyboard-operable, collapsed-by-default disclosure inside the sidebar scroller. It provides:

- Fetch all configured remotes without changing local files; Pull is **fast-forward only**, requires a clean working tree and an upstream, disables autostash/rebase, and refuses divergence rather than merging, rebasing or resetting.
- Create a branch and switch via the header selector. The inline branch-name input receives focus; Escape closes it and returns focus to the trigger.
- Stash all staged/unstaged/untracked files; list the latest 30 stashes; restore a selected stash including its index state only into a clean working tree. Restore **keeps the saved stash**, including on failure/conflict; there is no implicit pop/drop.
- Read-only recent history: latest 30 commits with subject, short hash, author and date. An unborn branch has an empty history. This is not a full history graph or commit-diff browser.

Tracked, non-conflicted working-tree rows additionally expose Discard with an explicit irreversible-action confirmation. It restores only the selected file's unstaged changes **from the index**, preserving staged hunks. Untracked files, directory/pattern targets and submodules are not discarded by this command. Literal pathspecs and repository-root confinement are enforced in the backend. There is no clean/reset/force action.

All new Git commands use the existing noninteractive argument-vector process helpers through Tauri `run_blocking`, off the UI thread. Repository-detail responses are bounded and generation-guarded. Operations which reload the project respect the existing unsaved-Preview confirmation.

## Implementation ownership

- `desktop/src/components/GitPanel.svelte`: branch/status, review checkpoint, panel composition.
- `desktop/src/components/GitCommitComposer.svelte`: editable draft, preparation buttons and explicit commit choice.
- `desktop/src/components/GitChangesSection.svelte` and `GitRepositoryTools.svelte`: file operations and secondary tools.
- `desktop/src/components/GitDiffPane.svelte`: full-height Review/Diff editor and fix/copy actions.
- `desktop/src/app/git-workspace.svelte.ts`: Git transaction, workspace state, review retention, IPC and lifecycle guards.
- `desktop/src/app/git-assist.ts`: model preparation and verified fix-session handoff.
- `desktop/src/app/desktop-sidebar-view-model.svelte.ts`, `desktop-navigation-view-model-services.ts`, `desktop-workbench-git-services.ts` and `desktop-workbench-prop-builders.ts`: workspace-assistant readiness for Source Control and Git Diff, independent of conversation-tab runtime readiness.
- `desktop/src/lib/acp-client.ts`, `desktop/src/lib/acp-pix-extensions.ts`, `acp/src/acp/desktop-commands.ts` and `acp/src/acp/pix-acp-agent.ts`: cwd-bound Git-assistant request transport and standalone ACP execution without allocating a conversation session.
- `desktop/src/lib/git-workflow.ts` and `git.ts`: shared policies, types and prompt/draft helpers.
- `desktop/src-tauri/src/git_operations.rs`: secondary commands and temporary-repository tests; minimal registration in `lib.rs`.

## Verification

`npm --prefix desktop run check`, `npm --prefix desktop test`, and `npm --prefix desktop run build:web` cover static checking, the existing suite and production frontend compilation. Focused behavior tests are in `git-workspace.test.ts`, `git-assist-workflow.test.ts`, `git-assist.test.ts`, `desktop-workbench-prop-builders.test.ts`, `git-workflow.test.ts` and `DesktopEditorSurfaces.test.ts`. ACP request parsing and standalone dispatch are covered by `acp/test/desktop-commands.test.ts` and `acp/test/agent.test.ts`.

`npm --prefix desktop run test:git-workflow` mounts the real Svelte components with deterministic fake Git/ACP callbacks in Chromium. It exercises all three flows, partial/explicit staging, draft races, push partial success, no-session/no-remote/conflict states, keyboard controls, stable review/diff selection, full-height review and 360px light/dark Source Control geometry/semantic colors. Screenshots are written to ignored `desktop/.artifacts/git-workflow/`.

`cargo test --manifest-path desktop/src-tauri/Cargo.toml git_secondary` exercises real local Git in temporary repositories: bounded/unborn history, stash/index/untracked preservation, safe discard, fetch/pull and divergence refusal. Browser callbacks do not contact a remote or paid model, and these tests do not alter the user's repository index, commits, remotes or stashes. Live provider/native-webview end-to-end behavior is a separate integration check, not asserted by the browser fixture.
