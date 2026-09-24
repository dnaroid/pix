# Desktop IDX panel

<!-- markdownlint-disable MD013 -->

## Type

Change

## Lifecycle

Active implemented contract.

## Goal

Expose installed IDX v2 repository intelligence in Pix Desktop with typed queries and explicit task-scoped, read-only documentation audits. The panel is not a shell runner or a wiki metadata editor.

## Scope

- IDX activity view in the workspace sidebar, with availability, version, initialization and code-index status for the active workspace.
- Named index maintenance (initialize, incremental/full update, dry run, doctor), bounded streamed output, cancellation and managed installation.
- Typed search of code (`idx search --domain code`) and documents (`idx search --domain document`), context packs, evidence-cited `idx ask`, and typed index inspections.
- Knowledge tab: explicit changed project-relative paths entered one per line or comma-separated; read-only `idx audit <paths...>` scoped to those paths.
- Optional **Update in new session** for agent-led review and updates; no metadata mutations from the panel.
- IDX output file references become source-preview links only after project-file validation, preserving line ranges.

## Behavior

- Overview resolves installed IDX from the login shell first, then Pix's managed tools directory. Unavailable IDX offers an explicit managed installation; installation does not initialize the project. Initialization requires its own button.
- Overview reads `idx --version` when IDX is available and presents only `indexStatus` from `idx index --status` for initialized projects; no wiki status request or knowledge freshness counts exist in IDX v2. Polling is completion-spaced, generation/workspace guarded and visually quiet. Queries require an available initialized project.
- Maintenance kinds are `init`, `index`, `full-index`, `dry-run`, `doctor`. The backend serializes operations per workspace, bounds output/history/time, streams events, and interrupts then forcibly stops cancelled operations. The runtime reconciles events emitted before operation-start response. Workspace changes cannot show old operation records.
- Code search offers hybrid/semantic/lexical/symbol ranking modes, max files, optional path prefix/content. Document search uses the knowledge query kind on the Tauri wire with `limit` and optional path prefix; the backend maps it to `search --domain document --max-files`. Neither document nor context queries send legacy `includeSecondary`.
- Context offers bounded budget and spec/code/test result counts. Ask takes a question and a separate 200–20000 token answer budget. Advanced inspections are restricted to architecture, structure, ast, explain, deps with typed targets and limits; AST file targets must be safe project-relative paths.
- The Knowledge tab requires at least one explicit project-relative changed path before running `idx_audit`. Blank, absolute and traversing paths are rejected in the UI, with backend validation authoritative. The request contract is `{ workspace, paths: string[] }` returning `IdxCommandResult`; audit output is shown through `IdxOutput`, which validates candidate links before activation. In-flight results are invalidated on workspace change or path-list edits; stale errors/results cannot overwrite the current workspace.
- **Update in new session** starts a fresh Desktop session for project knowledge review. It is not an IDX wiki command.

## Contracts and limits

- Overview/status commands have a 30-second backend timeout. Query/inspect/audit commands have a 180-second timeout and retain at most 512 KiB output. Long-running maintenance has a 30-minute timeout, 256 KiB streamed log and at most 12 records per window.
- Code search accepts at most 50 files, document search at most 20; context uses 200–8000 tokens and ask uses 200–20000. Backend canonicalizes the workspace and rejects uninitialized projects for non-init commands.
- No wiki status, discovery, catalog, impact, or metadata mutation actions are supported by this panel.

## Related files

- `desktop/src/components/IdxPanel.svelte`
- `desktop/src/components/idx-panel-runtime-controller.svelte.ts`
- `desktop/src/components/idx-panel-query-controller.svelte.ts`
- `desktop/src/components/idx-panel-audit-controller.svelte.ts`
- `desktop/src/components/IdxOutput.svelte`
- `desktop/src/lib/idx.ts`
- `desktop/src/lib/idx.test.ts`
- `desktop/src-tauri/src/lib.rs`

## Verification

- Desktop tests cover task path normalization/rejection, link candidates with line ranges, stale-completion guards, managed-install unavailable state and operation reconciliation.
- Rust unit tests cover typed domain/ask/audit argument construction and path validation. Run focused Desktop tests, `npm --prefix desktop run check`, and the Rust IDX tests.
