# Desktop IDX panel

<!-- markdownlint-disable MD013 -->

## Type

Change

## Lifecycle

Active implemented contract.

## Goal

Expose repository intelligence and Spec Wiki maintenance from Pix Desktop without turning the UI into an arbitrary command runner or weakening IDX's review requirements for knowledge mutations.

## Scope

- Add an **IDX** activity view to the left Workspace sidebar.
- Show IDX availability, version, index status, and Spec Wiki status for the active workspace.
- Summarize current/proposed knowledge separately from archived primary entries and surface semantic maintenance state without treating unresolved path references as stale by themselves.
- Run bounded index/knowledge maintenance operations with streamed output and cancellation.
- Start a dedicated Desktop session that performs the full knowledge-base audit/update workflow.
- Run typed code, knowledge, context, architecture, structure, AST, symbol, and dependency queries.
- Expose reviewed Spec Wiki metadata actions (`show`, `record`, `verify`, `relate`, `remove`, `impact`).
- Turn validated project-file references in IDX output into source-preview links, preserving optional line ranges.

## Non-goals

- Executing arbitrary shell commands supplied by the user.
- Automatically initializing an unindexed project without an explicit action.
- Editing a primary knowledge document through the metadata controls.
- Bypassing IDX's source/evidence review gates for `record`, `verify`, or `relate`.
- Treating an unvalidated path printed by IDX as a trusted project file.

## Behavior

- The Workspace activity rail contains an **IDX** view. Its wider content width is clamped so the main workspace keeps a usable minimum width.
- The activity-rail IDX icon participates in the shared Desktop sidebar-indicator service. It shows info while maintenance is running, warning when current/proposed knowledge is not fully fresh or needs semantic maintenance, and error for unseen failed/timed-out maintenance or IDX health failures. `unresolved refs` alone do not trigger the warning dot. See `desktop-sidebar-indicators.md` for polling and acknowledgement semantics.
- The overview resolves `idx` from the Desktop process environment and reports it as unavailable when the executable cannot be found. A project is initialized when its canonical workspace contains `.indexer-cli`.
- Knowledge statistics show the parsed `current/proposed` primary count as **Current**, compare **Fresh** against that set, keep **Review** explicit, label path-like misses as **Unresolved refs** with neutral treatment, and report non-current primary entries separately as archived.
- Maintenance actions are fixed to: initialize, update index, full reindex, dry run, doctor, knowledge audit, knowledge discovery, and knowledge catalog. Every command runs with the canonical workspace as its working directory.
- Only one IDX maintenance operation may run for a workspace at a time. Stdout/stderr stream into the panel; the retained per-operation log is bounded, completed operation history is bounded per window, and operations time out rather than running forever.
- After a maintenance start returns, the panel registers the returned snapshot and immediately reconciles it with backend operation state. Output or completion emitted before the start response is therefore recovered without regressing a newer event received during reconciliation.
- Stop first interrupts the IDX process group and escalates to a forced kill after a short grace period. Switching away from a workspace stops that window's running IDX operation for the old workspace.
- Overview refresh is best-effort and periodic while the panel is idle. Refresh requests are coalesced and generation/workspace guarded so a slow status command cannot overwrite a newer workspace/panel snapshot. Query/inspect controls are disabled until IDX is available and the project is initialized.
- Code search supports hybrid, semantic, lexical, and symbol modes plus an optional path prefix and optional inline content. Knowledge search supports a bounded result limit and optional secondary knowledge. Context queries expose bounded budget/spec/code/test limits.
- Inspection is restricted to the typed IDX commands `architecture`, `structure`, `ast`, `explain`, and `deps`; the backend constructs their argument lists and clamps numeric limits instead of forwarding free-form command text.
- Knowledge metadata actions use the typed IDX wiki commands. `record` requires `sourceReviewed=true`; `verify` and `relate` require `evidenceReviewed=true`; `remove` requires explicit metadata-only confirmation and does not delete the source file.
- **Update in new session** creates and warms a fresh ACP/Pi session for the active workspace, makes it the active Desktop tab, inserts a visible user request, and immediately starts a turn instructing the agent to audit/discover/impact current knowledge, reconcile specs against code/tests, update metadata only after evidence review, and finish with a clean knowledge-status pass. The prompt explicitly does not assume legacy behavior is supported and does not hide unresolved project-local/runtime paths just to improve a counter.
- IDX output is rendered as text until a project-file candidate passes workspace-confined validation. Valid candidates become preview controls. References with `:line` or `:start-end` carry that range into the source preview, which highlights and reveals the requested lines.

## Contracts and limits

- Overview/status commands have a 30-second backend timeout. Query, inspect, and knowledge actions have a 180-second timeout and retain at most 512 KiB of command output.
- Long-running maintenance operations have a 30-minute timeout, retain at most 256 KiB of streamed output, and keep at most 12 operation records per window.
- Code search is clamped to at most 50 files; knowledge search to at most 20 results; context budget is clamped to 200–8000 tokens with bounded spec/code/test counts.
- All backend entry points canonicalize the workspace before running IDX. Inspect, knowledge, and non-init maintenance paths reject an uninitialized project.

## Related files

- `desktop/src/components/WorkspaceSidebar.svelte`
- `desktop/src/components/IdxPanel.svelte`
- `desktop/src/components/IdxOutput.svelte`
- `desktop/src/components/TerminalView.svelte`
- `desktop/src/components/PreviewDialog.svelte`
- `desktop/src/lib/idx.ts`
- `desktop/src/lib/idx.test.ts`
- `desktop/src/lib/project-files.ts`
- `desktop/src/App.svelte`
- `desktop/src-tauri/src/lib.rs`

## Verification

- Desktop IDX helper tests cover overview-field parsing, current/archive counts, semantic attention rules, knowledge issue/candidate parsing, and file references with optional line ranges.
- Rust unit tests cover event payload serialization, typed query/inspect argument construction, overview parsing, knowledge review gates, and project-file link validation. TypeScript helper tests cover post-start operation reconciliation.
- Run `npm --prefix desktop test`, `npm --prefix desktop run check`, and the Desktop Tauri Rust unit tests.

## Evidence

- Confirmed by code: `IdxPanel.svelte` owns the typed UI state and invokes only named Tauri commands; `lib.rs` constructs fixed IDX argument vectors, canonicalizes workspaces, clamps limits, and enforces review confirmations.
- Confirmed by code: maintenance operations stream through `idx://operation-output` / `idx://operation-exit`, are cancellable, and have bounded output/history/timeouts.
- Confirmed by tests: TypeScript helper tests and Rust IDX tests cover parsing, typed argument construction, safety confirmations, and project-file candidate validation.
