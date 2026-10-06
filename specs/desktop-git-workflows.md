---
kind: spec
status: active
---

# Desktop Source Control workflows

<!-- markdownlint-disable MD013 -->

## Type

Change

## Lifecycle

Active implemented contract.

## Goal

Optimize Source Control for message generation → commit → push, code review → commit → push, code review → a separate fix session, and failed CI → an autonomous repair session. Keep ordinary Git operations available without giving them the same visual priority as the daily workflows.

## Primary workspace UI

The sidebar header shows the local branch, upstream, outgoing/incoming counts, status refresh and a standalone Push/Publish action. Opening Source Control and its Refresh action first read local status, fetch configured remotes when present, then refresh status so incoming counts reflect the fetched refs; this check never pulls or changes working-tree files. The branch selector also allows leaving detached HEAD. Incoming commits, conflicts, errors and completed operations have explicit feedback.

When the selected workspace is not a Git repository, Source Control shows an explicit **Initialize Git** empty state instead of treating the expected missing-repository condition as an error. Initialization runs `git init -b main` for the exact selected workspace and is idempotent. If the selected workspace is already inside a different repository, Desktop preserves the repository-root error and does not offer or create a nested repository; the parent repository root must be opened as the Pix project instead.

The commit composer remains outside the file-list scroller. It has visible Generate message, Code review, Commit and Commit & push controls. Its message textarea grows with the draft from 64 px up to 160 px, then scrolls internally, without exposing a native resize handle. Commit & push is primary when pushing is available; Commit remains available for local work without a remote. Missing Git-assistant readiness disables only AI preparation, not manual Git operations or message editing. Git preparation uses the standalone assistant for the selected workspace and requires only a connected, ready ACP client and nonempty workspace; it does not create, load or depend on a conversation session. The Source Control view clamps its content pane to a 360 px minimum so these desktop actions keep their single-line labels and normal control spacing instead of compressing into a cramped layout.

Staged and working-tree changes retain file status, per-scope additions/deletions, individual stage/unstage, stage/unstage-all and diff inspection. A path filter narrows visible rows. Bulk actions still affect their entire scope, including filtered-out files, and their tooltips state this. The filter resets when the workspace changes.

### Remote CI for the current HEAD

When HEAD exists, Source Control shows a compact CI state beside the upstream/ahead/behind summary. CI is bound to the exact full HEAD SHA, never merely the branch name, so a previous green run on the same branch cannot be presented as the result for unpublished local commits. The detail disclosure is collapsed by default and lists matching GitHub Actions workflow runs or GitLab pipelines. Jobs are fetched lazily when an individual run is first expanded; runs the user has opened are refreshed again after later CI-status polls so queued/running jobs can settle without reopening the app. Opening several runs cannot start job lookups in parallel, and background job refresh keeps the previous rows visible instead of replacing them with a loading placeholder.

When the aggregate state for the exact current HEAD is failed, the disclosure exposes a text-style **Fix with AI** action. The action captures that failed HEAD, creates a distinct conversation session in the same workspace, and submits a CI-repair prompt that instructs the agent to inspect provider logs, preserve unrelated user changes, reproduce failures locally where practical, fix the root cause, run relevant checks, commit and push only the repair, then monitor the next remote run and repeat until CI is green. The workflow explicitly forbids force-push/history rewriting and stops early only for credentials, permissions, external outages, or required human input. If the failed CI snapshot, workspace, client or Git lifecycle changes while the repair session is being allocated, Desktop does not activate stale work and closes any orphan session.

`desktop.git.ciFixModelRef` controls the model for **Fix with AI** and accepts the same optional `:thinking` suffix as the other Source Control model preferences. When this field is omitted, Desktop passes no model override to `session/new`, so the new repair session uses the normal Desktop default model and its default thinking. The preference is reloaded when the action starts so a just-saved Settings change is honored without restarting Desktop; a project Desktop config may override the user value through the normal preference precedence.

Provider access reuses the user's installed and authenticated `gh` or `glab` CLI. Desktop does not store provider tokens and does not fall back to browser credentials. The selected remote follows the current branch's configured remote when present, otherwise `origin`, otherwise the only configured remote. Multiple non-`origin` remotes without a configured branch remote are an explicit ambiguous setup state rather than an arbitrary choice. GitHub/GitLab and hostnames containing those provider names are supported; unsupported hosts, missing CLIs and missing authentication are explicit non-fatal setup states. For missing CLI/authentication, the CI disclosure shows the matching macOS Homebrew install command, a host-scoped `gh auth login` or `glab auth login` command, Copy actions, and links to the provider's official install/authentication documentation; after setup, Refresh retries detection. Provider CLI prompts, update checks and telemetry are disabled for background queries.

CI refresh is independent from local `git status`. A new workspace/HEAD/upstream/publication signature invalidates prior CI data and cancels its native request. If a native CI request discovers that repository HEAD changed before the Git snapshot caught up, it returns a transient `headChanged` result instead of a user-facing error; Desktop immediately refreshes Git state and retargets CI to the new SHA. Status requests are serialized and repeated refreshes coalesce; while Source Control is visible, active runs poll about every 8 seconds and settled runs about every minute. Leaving Source Control cancels transient panel work and suspends its timer/job polling. The unified sidebar remote lane may then refresh status only, about every minute in foreground or five minutes in background, to show current-HEAD CI failure without opening the panel. It skips active/in-flight/setup-unavailable requests; job caches retain only runs present in the current snapshot. Provider/native failures retry on the idle cadence, while setup states do not busy-poll. Successful provider queries avoid a separate authentication probe; `auth status` is used only after a provider command fails so normal polling does not double network traffic. Every completion is generation/workspace/HEAD/request guarded. Window teardown and app exit cancel registered native CI requests, and each external CLI process has a hard deadline, isolated process ownership, bounded stdout/stderr capture and forced descendant cleanup before pipe-reader join.

## Preparation and commit semantics

- The dirty Git sidebar-dot menu also offers **Stage all, AI commit & push**.
  This explicit command always stages all working-tree changes (including
  previously unstaged files), generates a message using the workspace assistant,
  then commits and pushes without an intermediate composer step. It does not open
  the Git panel and keeps one mutation lock throughout. Opening Source Control is
  not a prerequisite: an unloaded full status does not disable this self-refreshing
  command. It is
  disabled while Git is busy, the assistant is unavailable, or publication is
  known to be unsafe. Unknown status is checked by the transaction before any
  staging; failure or unsafe fresh status aborts without mutating the index.
  Fresh status is required before staging and again before committing;
  stale workspace/assistant results, changed staged content, changed branch/HEAD
  or publication target, conflicts and behind-upstream state stop the chain.
  Concurrent panel/background refreshes share one in-flight status read rather
  than superseding the transaction's read. Each mutation checkpoint waits out any
  earlier read and starts a new read, so sharing cannot reuse a pre-mutation snapshot.
  A staging/generation/commit failure never proceeds to push. A failed push keeps
  the local commit and presents Retry Push, never silently generating another
  commit. Existing composer Generate and manual Commit staging behavior is unchanged.

- Generate message describes only the staged diff. With no staged files its label becomes **Stage all & generate**, explicitly adding all changed/untracked files before generation. Failure to stage stops the sequence. Existing partial staging is never silently expanded by Generate message or Commit.
- Desktop Git reads disable Git's optional index locking so status/diff refreshes do not contend with Pix-owned stage/unstage mutations. Stage/unstage retries brief `.git/index.lock` contention before failing. A persistent lock is never deleted automatically; the UI reports a concise recovery message telling the user to finish the other Git operation or remove the stale lock only when no Git process is running.
- Code review targets staged changes when staging is nonempty, otherwise all changes. The scope is visible beside the commit-message label. Review all is also available independently. Reviewing never stages, commits or pushes.
- The message is an editable per-workspace draft. Edits persist immediately. A generated result cannot overwrite edits made while it was in flight or write into a disposed/workspace-replaced composer.
- Commit creates a local commit from the index. Commit & push is one explicitly requested, serialized commit-then-push transaction; a failed commit never starts push. A failed push after a successful commit reports partial success and instructs the user to retry Push rather than commit again. Only the submitted, unchanged draft is cleared after a successful local commit, including partial success. Commit completion follows the Git process itself: background work launched by a successful post-commit hook must not keep Desktop stuck in the committing state merely by inheriting Git stdout/stderr handles.
- Ctrl/Cmd+Enter runs Commit & push when pushing is available, otherwise Commit locally. Ctrl/Cmd+Shift+Enter always commits locally. Disabled-state checks also apply to these shortcuts.
- Pushing is unavailable for detached HEAD, no configured remote, ambiguous publication targets or known incoming commits. Publication follows the existing backend selection rule: prefer origin, otherwise use the only remote. There is no force push. Existing local commits can be pushed without making another commit.

## Review checkpoint and fixing

The most recent review is workspace-owned, independent of the selected diff editor. Inspecting another file or closing/reopening the Git Diff tab does not discard its findings. A sidebar checkpoint exposes the result, scope, View action and **Fix in new session** when there are findings.

The editor has Review and Diff views. Review uses the full editor height with an independently scrolling findings body and a stable action header; it is no longer restricted to a small split above the diff. Completing a review does not switch somebody away from a manually selected Diff view. Copy prompt remains available with clipboard feedback, subject to the same stability guards.

Every review starts with a fresh backend diff, not a cached editor preview. After the model responds, the diff is rechecked. Status refresh also revalidates retained reviews. Workspace mutations invalidate reviews conservatively; changing staged scope requires review again for the fix-session handoff. A stale review remains readable but cannot start a fix session. Failed and empty reviews are not treated as actionable findings. Review is advisory, not a mandatory commit gate.

Fix in new session rechecks the reviewed diff immediately before allocating a session. It uses the existing runtime/session machinery to create and activate a distinct session with the review-resolution prompt. That prompt requires verifying findings against current files, preserving unrelated changes, adding relevant tests, and **not committing or pushing** without an explicit user request. A workspace switch during creation cleans up the unused session. Starting a fixing session invalidates the checkpoint to prevent repeated handoff of the same snapshot.

LLM results and Git mutation completions are bound to their originating workspace lifecycle. An A → B → A workspace switch does not authorize a completion from the first A lifecycle to overwrite data or release locks in the second. Staged-diff changes during message generation cause the generated result to be rejected.

## Secondary repository tools

### Repository commit author

Source Control includes a separate, keyboard-operable **Commit author** disclosure,
collapsed by default. It loads the current Git `user.name` and `user.email`
configuration on first opening, labels each value as a repository override or
inherited Git setting, and provides Name, Email, **Save for repository** and
Reload controls. This is commit metadata, not authentication or a change of the
account used to push. Environment author/committer overrides are not displayed.

Save trims and validates both nonempty fields, rejecting control characters,
angle brackets and values over 320 UTF-8 bytes without imposing public-email
syntax. Both keys are replaced together in the repository's common Git config
under Git's exclusive `config.lock`, preserving other config and its permissions.
Global/system/included config and existing commits are not modified. Linked
worktrees share this common config; separate worktree config, when enabled, can
still override it. The editor reloads effective Git configuration after saving
rather than assuming the new common-config values take precedence.

Saving shares the existing Git mutation lock, so commits/staging and author
updates cannot overlap through Pix. Loading, disabled, success and error states
are explicit. Failed writes leave the existing config unchanged and never delete
another process's lock. Draft/read/save completions are panel-lifecycle guarded:
switching workspaces or unmounting cannot populate a new panel, and stale mutation
completion cannot release a later lifecycle's lock. A successful save does not
invalidate an existing diff review. Native reads/writes use `run_blocking` and the
noninteractive argument-vector helpers. See
[decision 0053](../docs/decisions/0053-repository-commit-author.md).

**Branches & stashes** and **Log** are separate keyboard-operable, collapsed-by-default disclosures inside the sidebar scroller. The header additionally offers Fetch and Update project:

- **Update project** fetches, then fast-forwards the upstream without merging or rebasing. It requires a non-detached branch with an upstream and no conflicts, but permits local changes: it temporarily stashes staged, unstaged and untracked work, restores it after the attempt, and drops only its own stash after successful restoration. If index restoration is impossible before any files were touched, it may restore without the index state; conflicts retain the recovery stash and explicit error. Existing user stashes remain untouched. Divergence aborts before stashing. An already-current branch reports no incoming commits and leaves local changes alone.

- Fetch all configured remotes without changing local files; Pull is **fast-forward only**, requires a clean working tree and an upstream, disables autostash/rebase, and refuses divergence rather than merging, rebasing or resetting.
- Create a branch and switch via the header selector. The inline branch-name input receives focus; Escape closes it and returns focus to the trigger.
- Stash all staged/unstaged/untracked files; list the latest 30 stashes; restore a selected stash including its index state only into a clean working tree. Restore **keeps the saved stash**, including on failure/conflict; there is no implicit pop/drop.
- Read-only recent history: latest 30 commits with subject, short hash, author and date. An unborn branch has an empty history. This is not a full history graph or commit-diff browser.

Tracked, non-conflicted working-tree rows additionally expose Discard with an explicit irreversible-action confirmation. It restores only the selected file's unstaged changes **from the index**, preserving staged hunks. Untracked files, directory/pattern targets and submodules are not discarded by this command. Literal pathspecs and repository-root confinement are enforced in the backend. There is no clean/reset/force action.

All new Git commands use the existing noninteractive argument-vector process helpers through Tauri `run_blocking`, off the UI thread. Repository-detail responses are bounded and generation-guarded. Operations which reload the project respect the existing unsaved-Preview confirmation.

## Implementation

Repository commit-author and secondary synchronization dependencies (the broader workflow ownership map follows):

- `desktop/src/components/GitPanel.svelte`
- `desktop/src/components/GitIdentitySection.svelte`
- `desktop/src/lib/git-identity-editor.svelte.ts`
- `desktop/src/lib/git-workflow.ts`
- `desktop/src/app/git-workspace.svelte.ts`
- `desktop/src/app/desktop-sidebar-view-model.svelte.ts`
- `desktop/src-tauri/src/git_identity.rs`
- `desktop/src-tauri/src/git_operations.rs`
- `desktop/src/components/GitRepositoryTools.svelte`
- `desktop/src-tauri/src/lib.rs`

## Tests

- `desktop/src/lib/git-identity-editor.test.ts`
- `desktop/src/app/git-workspace.test.ts`
- `desktop/src-tauri/src/git_identity.rs`
- `desktop/src-tauri/src/git_operations.rs`
- `desktop/scripts/fixtures/GitWorkflowFixture.svelte`

## Implementation ownership

- `desktop/src/components/GitPanel.svelte`: branch/status, review checkpoint, panel composition.
- `desktop/src/components/GitIdentitySection.svelte` and `desktop/src/lib/git-identity-editor.svelte.ts`: repository-author disclosure, draft and lifecycle handling.
- `desktop/src-tauri/src/git_identity.rs`: effective/local configuration reads and locked, repository-only two-key saves.
- `desktop/src/components/GitCiSection.svelte`, `desktop/src/app/git-ci.svelte.ts` and `desktop/src/lib/git-ci.ts`: current-HEAD CI presentation, polling/lazy jobs and normalized provider state.
- `desktop/src/components/GitCommitComposer.svelte`: editable draft, preparation buttons and explicit commit choice.
- `desktop/src/components/GitChangesSection.svelte` and `GitRepositoryTools.svelte`: file operations and secondary tools.
- `desktop/src/components/GitDiffPane.svelte`: full-height Review/Diff editor and fix/copy actions.
- `desktop/src/app/git-workspace.svelte.ts`: Git transaction, workspace state, review retention, IPC and lifecycle guards.
- `desktop/src/app/git-assist.ts`: model preparation, verified review fix-session handoff, and failed-CI repair-session handoff.
- `desktop/src/app/desktop-sidebar-view-model.svelte.ts`, `desktop-navigation-view-model-services.ts`, `desktop-workbench-git-services.ts` and `desktop-workbench-prop-builders.ts`: workspace-assistant readiness for Source Control and Git Diff, independent of conversation-tab runtime readiness.
- `desktop/src/lib/acp-client.ts`, `desktop/src/lib/acp-pix-extensions.ts`, `acp/src/acp/desktop-commands.ts` and `acp/src/acp/pix-acp-agent.ts`: cwd-bound Git-assistant request transport and standalone ACP execution without allocating a conversation session.
- `desktop/src/lib/git-workflow.ts` and `git.ts`: shared policies, types and prompt/draft helpers.
- `desktop/src-tauri/src/git_operations.rs`: secondary commands and temporary-repository tests; `desktop/src-tauri/src/git_ci.rs`: bounded/cancellable `gh`/`glab` queries and provider normalization; `desktop/src-tauri/src/lib.rs`: repository detection/initialization, command registration and window/app teardown.

## Verification

Repository-author regression coverage is in
`desktop/src/lib/git-identity-editor.test.ts` (inherited values, errors/retry,
read/edit races, serialized saves and disposal),
`desktop/src/app/git-workspace.test.ts` (shared mutation lock and A → B → A
completion), and `desktop/src-tauri/src/git_identity.rs` (real temporary Git
repositories, local-only save, included defaults, unchanged config on invalid
input/lock contention or staged-write failure, linked-worktree precedence,
permissions/history preservation, and exact-root confinement). Run the native subset with
`cargo test --manifest-path desktop/src-tauri/Cargo.toml git_identity`.

The sparse closed-panel lane follows [sidebar indicators](desktop-sidebar-indicators.md) and [decision 0025](../docs/decisions/0025-sidebar-health-polling.md).

`npm --prefix desktop run check`, `npm --prefix desktop test`, and `npm --prefix desktop run build:web` cover static checking, the existing suite and production frontend compilation. Focused behavior tests are in `git-ci.test.ts`, `GitCiSection.test.ts`, `git-workspace.test.ts`, `git-assist-workflow.test.ts`, `git-assist.test.ts`, `desktop-workbench-prop-builders.test.ts`, `git-workflow.test.ts` and `DesktopEditorSurfaces.test.ts`; CI-repair tests cover default/configured model selection, prompt policy and stale failed-HEAD cleanup, while the CI store tests cover stale workspace/HEAD completion, refresh coalescing, teardown cancellation and serialized job loading. Rust tests cover provider URL/status normalization in addition to exact-root Git initialization and nested-repository refusal. ACP request parsing and standalone dispatch are covered by `acp/test/desktop-commands.test.ts` and `acp/test/agent.test.ts`.

`npm --prefix desktop run test:git-workflow` mounts the real Svelte components with deterministic fake Git/ACP callbacks in Chromium. It exercises all three flows, partial/explicit staging, draft races, push partial success, no-session/no-remote/conflict states, keyboard controls, stable review/diff selection, full-height review and 360px light/dark Source Control geometry/semantic colors. Screenshots are written to ignored `desktop/.artifacts/git-workflow/`.

`cargo test --manifest-path desktop/src-tauri/Cargo.toml git_secondary` exercises real local Git in temporary repositories: bounded/unborn history, stash/index/untracked preservation, safe discard, fetch/pull and divergence refusal. Browser callbacks do not contact a remote or paid model, and these tests do not alter the user's repository index, commits, remotes or stashes. Live provider/native-webview end-to-end behavior is a separate integration check, not asserted by the browser fixture.
