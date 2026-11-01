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

The commit composer remains outside the file-list scroller. It has visible Generate message, Code review and commit controls. Its message textarea grows with the draft from 64 px up to 160 px, then scrolls internally, without exposing a native resize handle. With no Git remote configured, the header identifies a “Local repository · no remote”; the composer hides Commit & push, offers a single Commit action and explains that commits stay local. A branch without an upstream but with a remote is identified as “Local branch · not published”. Otherwise Commit & push is primary when pushing is available; Commit remains available for local work. Missing Git-assistant readiness disables only AI preparation, not manual Git operations or message editing. Git preparation uses the standalone assistant for the selected workspace and requires only a connected, ready ACP client and nonempty workspace; it does not create, load or depend on a conversation session. The Source Control view clamps its content pane to a 360 px minimum so these desktop actions keep their single-line labels and normal control spacing instead of compressing into a cramped layout.

Staged and working-tree changes retain file status, per-scope additions/deletions, individual stage/unstage, stage/unstage-all and diff inspection. Both file lists start expanded and can be independently collapsed using their keyboard-operable heading buttons. Counts, scope diff and bulk actions remain available when collapsed; these actions do not toggle the list. A path filter narrows visible rows. Bulk actions still affect their entire scope, including filtered-out files, and their tooltips state this. The filter resets when the workspace changes.

When there are no changed files, the panel presents a compact “Working tree clean” status. If the branch is ahead, it appends the local commit count and says “to push”, or “not pushed” when publication is blocked.

### Explorer local status reads

The mounted Project Explorer refreshes Git decorations about five seconds after
each completed read while the window is visible and focused, or thirty seconds
in the background. Refocusing and Pix-owned file operations request an immediate
read. Reads serialize and coalesce; unmounting stops scheduling, including after
an in-flight completion. Loading-state updates from the parent sidebar do not
restart this completion-based cadence. The lifecycle effect enqueues another read
only when the workspace or explicit refresh key changes, and runs its I/O callback
outside dependency collection so loading writes cannot enqueue redundant work.

Explorer requests `git_status` with `includeLineStats: false`: neither
`diff --numstat` nor untracked-file content reads for line counts run. The first
successful read bootstraps local branches and remotes. Subsequent Explorer reads
also set `includeRepositoryDetails: false`, skipping branch/remote listings while
still reading status paths and branch/upstream/HEAD/ahead/behind. The store keeps
cached branch/remote metadata; a branch or upstream switch triggers a metadata
reload. Other external branch-list/remote-config changes are picked up by the
next full read. Equal snapshots retain their identity and do not republish Git
decorations.

Both options default to true for Source Control, explicit Git retries and mutation
safety checkpoints. Explorer may share an in-flight full read; a full reader
arriving during a lean read waits for a subsequent full read. Workspace resets
discard cached metadata, queued upgrades and stale results, including metadata
reload completions.

### Remote CI for the current HEAD

When HEAD exists, Source Control shows a compact CI state beside the upstream/ahead/behind summary. CI is bound to the exact full HEAD SHA, never merely the branch name, so a previous green run on the same branch cannot be presented as the result for unpublished local commits. The detail disclosure is collapsed by default and lists matching GitHub Actions workflow runs or GitLab pipelines. Runs have no nested disclosure: metadata and jobs are visible together when the CI section is open. Jobs are fetched lazily when the CI section opens, including new runs arriving while it is open; observed runs are refreshed again after later CI-status polls so queued/running jobs can settle without reopening the app. Job lookups remain serialized, and background job refresh keeps the previous rows visible instead of replacing them with a loading placeholder.

When the aggregate state for the exact current HEAD is failed, the disclosure exposes a text-style **Fix with AI** action. The action captures that failed HEAD, creates a distinct conversation session in the same workspace, and submits a CI-repair prompt that instructs the agent to inspect provider logs, preserve unrelated user changes, reproduce failures locally where practical, fix the root cause, run relevant checks, commit and push only the repair, then monitor the next remote run and repeat until CI is green. The workflow explicitly forbids force-push/history rewriting and stops early only for credentials, permissions, external outages, or required human input. If the failed CI snapshot, workspace, client or Git lifecycle changes while the repair session is being allocated, Desktop does not activate stale work and closes any orphan session.

`desktop.git.ciFixModelRef` controls the model for **Fix with AI** and accepts the same optional `:thinking` suffix as the other Source Control model preferences. When this field is omitted, Desktop passes no model override to `session/new`, so the new repair session uses the normal Desktop default model and its default thinking. The preference is reloaded when the action starts so a just-saved Settings change is honored without restarting Desktop; a project Desktop config may override the user value through the normal preference precedence.

Provider access reuses the user's installed and authenticated `gh` or `glab` CLI. Desktop does not store provider tokens and does not fall back to browser credentials. The selected remote follows the current branch's configured remote when present, otherwise `origin`, otherwise the only configured remote. Multiple non-`origin` remotes without a configured branch remote are an explicit ambiguous setup state rather than an arbitrary choice. GitHub/GitLab and hostnames containing those provider names are supported; unsupported hosts, missing CLIs and missing authentication are explicit non-fatal setup states. For missing CLI/authentication, the CI disclosure shows the matching macOS Homebrew install command, a host-scoped `gh auth login` or `glab auth login` command, Copy actions, and links to the provider's official install/authentication documentation; after setup, Refresh retries detection. Provider CLI prompts, update checks and telemetry are disabled for background queries.

CI refresh is independent from local `git status`. A new workspace/HEAD/upstream/publication signature invalidates prior CI data and cancels its native request. If a native CI request discovers that repository HEAD changed before the Git snapshot caught up, it returns a transient `headChanged` result instead of a user-facing error; Desktop immediately refreshes Git state and retargets CI to the new SHA. Status requests are serialized and repeated refreshes coalesce; while Source Control is visible, active runs poll about every 8 seconds and settled runs about every minute. Leaving Source Control cancels transient panel work and suspends its timer/job polling. The unified sidebar remote lane may then refresh status only, about every minute in foreground or five minutes in background, to show current-HEAD CI failure without opening the panel. It skips active/in-flight/setup-unavailable requests; job caches retain only runs present in the current snapshot. Provider/native failures retry on the idle cadence, while setup states do not busy-poll. Successful provider queries avoid a separate authentication probe; `auth status` is used only after a provider command fails so normal polling does not double network traffic. Every completion is generation/workspace/HEAD/request guarded. Window teardown and app exit cancel registered native CI requests, and each external CLI process has a hard deadline, isolated process ownership, bounded stdout/stderr capture and forced descendant cleanup before pipe-reader join.

## Preparation and commit semantics

- The dirty Git sidebar-dot menu also offers **Stage all, AI commit & push**.
  This explicit command always stages all working-tree changes (including
  previously unstaged files), generates a message using the workspace assistant,
  then commits and pushes without an intermediate composer step. It does not open
  the Git panel and keeps one mutation lock throughout. The sidebar menu only
  labels it **Stage all, AI commit** when no remote is confirmed (including
  unloaded status), performing the same preparation and local commit without
  pushing. That local-only intent is preserved even if fresh status discovers a
  remote. Standalone Push is omitted without a confirmed remote.
  Local change review remains available. The combined command is
  disabled while Git is busy, the assistant is unavailable, or publication is
  known to be unsafe for the requested mode (publication guards apply only to
  commit-and-push). Unknown status is checked by the transaction before any
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
- File/scope diffs (`git_diff`) stream Git's output against a 512 KiB budget and kill Git once it is exceeded, returning a truncated diff with a marker instead of buffering the whole output. They do not take a full status snapshot: staged diffs list nothing extra, and working-tree diffs find untracked files with a literal-pathspec `git ls-files --others --exclude-standard` listing (at most 100 files rendered).
- Desktop Git reads disable Git's optional index locking so status/diff refreshes do not contend with Pix-owned stage/unstage mutations. Stage/unstage retries brief `.git/index.lock` contention before failing. A persistent lock is never deleted automatically; the UI reports a concise recovery message telling the user to finish the other Git operation or remove the stale lock only when no Git process is running.
- Code review targets staged changes when staging is nonempty, otherwise all changes. The scope is visible beside the commit-message label. Review all is also available independently. Reviewing never stages, commits or pushes.
- The message is an editable per-workspace draft. Edits are persisted to local storage after a 300 ms typing pause, and any pending edit is flushed immediately on blur, page hide/unload, commit completion, workspace switch and composer unmount — always under the workspace it was typed in. A generated result cannot overwrite edits made while it was in flight or write into a disposed/workspace-replaced composer.
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
[decision 0053](../../decisions/0053-repository-commit-author.md).

**Branches & stashes** and **Log** are separate keyboard-operable, collapsed-by-default disclosures inside the sidebar scroller. The header additionally offers Fetch and Update project:

- **Update project** fetches, then fast-forwards the upstream without merging or rebasing. It requires a non-detached branch with an upstream and no conflicts, but permits local changes: it temporarily stashes staged, unstaged and untracked work, restores it after the attempt, and drops only its own stash after successful restoration. If index restoration is impossible before any files were touched, it may restore without the index state; conflicts retain the recovery stash and explicit error. Existing user stashes remain untouched. Divergence aborts before stashing. An already-current branch reports no incoming commits and leaves local changes alone.

- Fetch all configured remotes without changing local files; Pull is **fast-forward only**, requires a clean working tree and an upstream, disables autostash/rebase, and refuses divergence rather than merging, rebasing or resetting.
- Create a branch and switch via the header selector. The inline branch-name input receives focus; Escape closes it and returns focus to the trigger.
- Stash all staged/unstaged/untracked files; list the latest 30 stashes; restore a selected stash including its index state only into a clean working tree. Restore **keeps the saved stash**, including on failure/conflict; there is no implicit pop/drop.
- Read-only recent history: latest 30 commits with subject, short hash, author
  and date. An unborn branch has an empty history. Clicking a Log entry opens
  that exact commit's patch in the existing workbench Git Diff tab, with a
  Source Control sidebar summary showing its subject, full hash, author and
  date, and a View diff action to return to it. The tab label includes the
  short hash. The Log remains capped to 30 entries, without a full history
  graph; universal search can open older HEAD ancestors not shown in the Log.
- Historical patches use a dedicated read-only `git_commit_diff` command.
  It requires an unambiguous full hexadecimal commit hash and verifies
  reachability from current HEAD; arbitrary refspecs and command options
  cannot be passed. Git runs off the UI thread without optional index locks
  and returns a bounded/truncated first-parent patch for normal, root and
  merge commits. No checkout, staging, rebase, reset, temporary worktree or
  file mutation is performed. Selection, close, and workspace lifecycle
  invalidate pending previews so older completions cannot overwrite a newer
  editor view. Historical patches are read-only inspection and do not
  expose the working-tree-only code review or mutation actions.
- [Universal search](../../search/desktop-universal-search.md) uses a separate read-only metadata
  command over all current HEAD ancestors; its candidate cap does not change this
  panel's 30-entry history. Each walk carries a request id: aborting the search
  calls `git_search_history_cancel`, which kills the `git log` process group
  (a cancel that overtakes its search is retained briefly and still applies),
  and every walk has a 30-second deadline, so stale per-query walks cannot pile
  up in large repositories. Optional hybrid commit indexing is a separate ACP
  search source, not a Source Control history refresh or Git mutation.

Tracked, non-conflicted working-tree rows additionally expose Discard with an explicit irreversible-action confirmation. It restores only the selected file's unstaged changes **from the index**, preserving staged hunks. Untracked files, directory/pattern targets and submodules are not discarded by this command. Literal pathspecs and repository-root confinement are enforced in the backend. There is no clean/reset/force action.

All new Git commands use the existing noninteractive argument-vector process helpers through Tauri `run_blocking`, off the UI thread. Repository-detail responses are bounded and generation-guarded. Operations which reload the project respect the existing unsaved-Preview confirmation.

Network Git operations (Push/Publish, Fetch, Pull and the fetch step of Update project) run through a supervised runner (`desktop/src-tauri/src/git_process.rs`) so a hung remote, SSH session or credential helper cannot hold a blocking worker and the Source Control spinner forever:

- Each command runs in its own process group with stdin closed, a 10-minute deadline and capped stdout (1 MiB) / stderr (256 KiB). On timeout the whole group (git, ssh, credential helpers) is killed and the user sees “Git *operation* timed out after 10 minutes; the remote or a credential helper did not respond…”; the timeout is also logged as `git:network-timeout` (operation name only, no arguments). After normal exit the group is also killed before the output readers join, so a helper that inherited the pipes cannot stall completion; Git's detached auto-gc uses its own session and is unaffected.
- SSH runs as `ssh -o BatchMode=yes -o ConnectTimeout=30 -o ServerAliveInterval=15 -o ServerAliveCountMax=4` so it never waits for a passphrase/host-key prompt and detects dead connections. This is set only when neither `GIT_SSH_COMMAND`, `GIT_SSH` nor `GIT_SSH_VARIANT` is in the environment and no `core.sshCommand`/`ssh.variant` is configured; a user's own SSH command always wins.
- HTTP(S) transfers abort when slower than 1000 B/s for 60 s (`GIT_HTTP_LOW_SPEED_LIMIT`/`_TIME`), unless the environment or any `http.*lowSpeedLimit`/`lowSpeedTime` config sets them. If the transport configuration cannot be read, no transport setting is overridden.
- There is no user-facing cancel for these operations yet; the deadline and transport guards bound them. The sidebar remote-update probe (`ls-remote`, 5-second deadline) shares the same supervisor.

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

The sparse closed-panel lane follows [sidebar indicators](../workbench/desktop-sidebar-indicators.md) and [decision 0025](../../decisions/0025-sidebar-health-polling.md).

`npm --prefix desktop run check`, `npm --prefix desktop test`, and `npm --prefix desktop run build:web` cover static checking, the existing suite and production frontend compilation. Focused behavior tests are in `git-ci.test.ts`, `GitCiSection.test.ts`, `git-workspace.test.ts`, `git-assist-workflow.test.ts`, `git-assist.test.ts`, `desktop-workbench-prop-builders.test.ts`, `git-workflow.test.ts` and `DesktopEditorSurfaces.test.ts`; CI-repair tests cover default/configured model selection, prompt policy and stale failed-HEAD cleanup, while the CI store tests cover stale workspace/HEAD completion, refresh coalescing, teardown cancellation and serialized job loading. Rust tests cover provider URL/status normalization in addition to exact-root Git initialization and nested-repository refusal. ACP request parsing and standalone dispatch are covered by `acp/test/desktop-commands.test.ts` and `acp/test/agent.test.ts`.

`npm --prefix desktop run test:git-workflow` mounts the real Svelte components with deterministic fake Git/ACP callbacks in Chromium. It exercises all three flows, partial/explicit staging, draft races, push partial success, no-session/no-remote/conflict states, keyboard controls, stable review/diff selection, full-height review and 360px light/dark Source Control geometry/semantic colors. Screenshots are written to ignored `desktop/.artifacts/git-workflow/`.

`cargo test --manifest-path desktop/src-tauri/Cargo.toml git_secondary` exercises real local Git in temporary repositories: bounded/unborn history, stash/index/untracked preservation, safe discard, fetch/pull and divergence refusal. Browser callbacks do not contact a remote or paid model, and these tests do not alter the user's repository index, commits, remotes or stashes. Live provider/native-webview end-to-end behavior is a separate integration check, not asserted by the browser fixture.

<!-- pix:wiki-check {"version":1,"status":"clear","contentHash":"2f3d5edeb5be5186708a0cb10a6c5ac3bb5e959aa57a5c92b4d5ca42b498bb41","checkedAt":"2026-10-31T01:11:20.632Z","modelRef":"zai/glm-5.3-flash","scope":"retrieved-passages","checkedSources":12,"candidateSources":62,"reportLanguage":"ru"} -->
