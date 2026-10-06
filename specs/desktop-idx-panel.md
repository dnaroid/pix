---
kind: spec
status: active
---

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
- Typed search of code (`idx search --domain code`) and documents (`idx search --domain document`), context packs, and typed index inspections.
- Knowledge tab: explicit changed project-relative paths entered one per line or comma-separated; read-only `idx audit <paths...>` scoped to those paths.
- Optional **AI review** for agent-led review and updates in a new session; no metadata mutations from the panel.
- IDX output file references become source-preview links only after project-file validation, preserving line ranges.

## Behavior

- Overview resolves installed IDX from the login shell first, then Pix's managed tools directory. Unavailable IDX offers an explicit managed installation; installation does not initialize the project. Initialization requires its own button.
- Overview reads `idx --version`, and for initialized projects `idx index --status` plus bounded read-only `idx knowledge dirty`. It exposes optional `knowledgeDirty` from complete exit-0 yes/no only (unsupported old CLIs remain unknown; incomplete results are errors), and conservative `indexStale` when the indexed Git revision differs from current HEAD. Matching HEAD does not prove freshness of uncommitted edits. No wiki request, inferred knowledge counts, automatic acknowledgment, dry-run or indexing is used for health. The overview also reports the project's IDX `embeddingProvider` from `.indexer-cli/config.json`, exposed only when it names `openrouter`; missing, oversized, malformed or other-provider configurations report none. Polling is completion-spaced, generation/workspace guarded and visually quiet. Queries require an available initialized project.
- Maintenance kinds are `init`, `index`, `full-index`, `dry-run`, `doctor`. Initialization UI exposes an opt-in **OpenRouter embeddings** checkbox that defaults checked only when the active workspace's overview reports the `openrouter` embedding provider, and unchecked when the provider is another value or unavailable. Manual checkbox edits are preserved across periodic overview refreshes within the same workspace; the checkbox resets to unchecked on workspace change until the new workspace's overview loads, and stale overview results from a previous workspace never seed it. When selected, initial `init` and doctor-driven reinitialization append `--embedding openrouter`, while index/full-index/dry-run never receive the flag. The backend serializes operations per workspace, bounds output/history/time, streams events, and interrupts then forcibly stops cancelled operations. The runtime reconciles events emitted before operation-start response. Workspace changes cannot show old operation records.
- Code search offers hybrid/semantic/lexical/symbol ranking modes, max files, optional path prefix/content. Document search uses the knowledge query kind on the Tauri wire with `limit` and optional path prefix; the backend maps it to `search --domain document --max-files`. Neither document nor context queries send legacy `includeSecondary`.
- Context offers bounded budget and spec/code/test result counts. Advanced inspections are restricted to architecture, structure, ast, explain, deps with typed targets and limits; AST file targets must be safe project-relative paths.
- The Knowledge tab requires at least one explicit project-relative changed path before running `idx_audit`. Blank, absolute and traversing paths are rejected in the UI, with backend validation authoritative. The request contract is `{ workspace, paths: string[] }` returning `IdxCommandResult`; audit output is shown through `IdxOutput`, which validates candidate links before activation. In-flight results are invalidated on workspace change or path-list edits; stale errors/results cannot overwrite the current workspace.
- **AI review** starts a fresh Desktop session for project knowledge review. Its prompt checks `idx knowledge dirty` before and after review, compares monitored active specs with their declared implementation/tests, and explicitly runs `idx knowledge acknowledge <spec-paths...>` only for genuinely reviewed specs with no unresolved drift (including accurate unchanged specs). Unreviewed specs, unresolved drift, unavailable sources, unsupported commands and other failures must be reported, not hidden by acknowledgment. A clean result may be claimed only after a successful final dirty check returns `no`; indexing/audit alone do not establish review. The panel itself does not acknowledge specs. It is not an IDX wiki command.
- The review session uses optional `desktop.knowledge.reviewModelRef` (`provider/model[:thinking]`), exposed as **Knowledge review model** in Settings → Assistant features. Preferences are re-read on each action from `~/.config/pi/pix-desktop.jsonc` and `$WORKSPACE/.pi/pix-desktop.jsonc`; a non-empty project value overrides the global value. Omission uses the normal new-session default. An invalid model reference reports an error without creating a session. The model/thinking override is passed at session creation, before runtime initialization or the review prompt. Stale workspace/client completions cannot start the review in another project. This setting does not change the separate `knowledge-auditor` sub-agent role or the global cleanup prompt/budget.
- Global **AI review** aims to restore the entire knowledge base to verified clean
  state, not merely complete an individual task audit. It does not consume the
  changed-path field used by **Audit paths**. Its cleanup todo succeeds only on a
  final complete exit-0 `idx knowledge dirty` result of `no`; a separate task audit
  may pass while global cleanup remains blocked.
- **AI review** performs all work itself in the new session: source review,
  documentation repairs, command checks, task audit and final acknowledgment.
  It must not invoke subagents or delegate to any role (including
  `knowledge-auditor`, `verify` or `research`), even when general workflow
  instructions require delegation. This service-specific rule prevents concurrent
  knowledge-base updates and lock conflicts; knowledge-base operations run
  sequentially, never in parallel. The session tracks dependency coverage,
  findings and gaps itself. This does not change general agent workflows outside
  this service. Disposable reports/logs use unique target-project `.pi/artifacts/`
  directories; existing harness evidence remains in `.pi/subagents/`.
- The prompt allows at most two review passes total (initial plus one corrective
  pass). Its eight concise instructions retain the global success, stable-review,
  self-contained sequential execution and escalation rules. The generated prompt is regression-tested for
  those safeguards and a compact size budget. The corrective
  pass is allowed only for identified, safely actionable, unblocked gaps. Stop early on
  verified `no`. Do not poll for cleanliness or bypass the limit with repeated
  commands, delegated loops or replacement sessions. Concurrent edits to a
  reviewed spec/dependency invalidate review; do not acknowledge unstable work
  or overwrite other agents' changes.
- Escalate immediately for unstable concurrent sources, missing required sources,
  review-blocking command failures/unsupported commands or unresolved product
  decisions. Also escalate if the pass limit ends with dirty `yes`/`unknown` or
  no safe corrective pass is available. Report global cleanup `blocked`, observed
  dirty state (`unknown` for incomplete/failed checks), blockers or explicitly
  unclassified dirtiness, reviewed/acknowledged paths, command errors/exit codes
  and the user action needed. Defer the global cleanup todo without claiming
  success, end the turn and resume only on explicit user instruction. This is a
  model-facing instruction budget, not a runtime-enforced watchdog.

## Contracts and limits

- Version/index-status commands have a 30-second backend timeout; knowledge health is limited to 5 seconds/4 KiB and revision comparison uses a bounded local Git probe. Isolated command descendants are killed before pipe readers are joined, including after successful leader exit. The overview reads the bounded project-local `.indexer-cli/config.json` (64 KiB) off the UI thread only to expose the narrowly typed `embeddingProvider` field. Query/inspect/audit commands have a 180-second timeout and retain at most 512 KiB output. Long-running maintenance has a 30-minute timeout, 256 KiB streamed log and at most 12 records per window.
- Code search accepts at most 50 files, document search at most 20, and context uses 200–8000 tokens. Backend canonicalizes the workspace and rejects uninitialized projects for non-init commands.
- No wiki status, discovery, catalog, impact, or metadata mutation actions are supported by this panel.

## Implementation

- `desktop/src/components/IdxPanel.svelte`
- `desktop/src/components/idx-panel-runtime-controller.svelte.ts`
- `desktop/src/components/idx-panel-query-controller.svelte.ts`
- `desktop/src/components/idx-panel-audit-controller.svelte.ts`
- `desktop/src/components/IdxOutput.svelte`
- `desktop/src/lib/idx.ts`
- `desktop/src/app/project-actions.svelte.ts`
- `desktop/src/app/desktop-project-action-services.ts`
- `desktop/src/app/project-workspace.svelte.ts`
- `desktop/src/lib/desktop-config.ts`
- `desktop/src/components/settings/DesktopSettingsEditor.svelte`
- `src/schemas/pix-desktop-schema.ts`
- `schemas/pix-desktop.json`
- `desktop/src-tauri/src/lib.rs`

## Tests

- `desktop/src/lib/idx.test.ts`
- `desktop/src/app/project-actions.test.ts`
- `desktop/src/lib/desktop-config.test.ts`
- `desktop/src/app/project-workspace.test.ts`
- `desktop/src/components/DesktopVisualRegressions.test.ts`
- `desktop/src/components/IdxPanel.test.ts`
- `desktop/src/components/idx-panel-query-controller.test.ts`
- `desktop/src/components/idx-panel-audit-controller.test.ts`
- `desktop/src-tauri/src/lib.rs`

## Verification

- Desktop tests cover task path normalization/rejection, link candidates with line ranges, stale-completion guards, managed-install unavailable state, operation reconciliation, and the OpenRouter checkbox default (openrouter provider, missing/malformed/other provider, manual override preserved across refreshes, reset on workspace change).
- Rust unit tests cover typed domain/context/audit argument construction, path validation, and overview embedding-provider parsing for openrouter/missing/malformed/other-provider/oversized configs. Run focused Desktop tests, `npm --prefix desktop run check`, and the Rust IDX tests.
- `IdxPanel.test.ts` checks source contracts, not rendered/native UI interaction;
  query and audit controller tests exercise stale completions directly.

## Decision

[Sparse read-only sidebar health](../docs/decisions/0025-sidebar-health-polling.md).

[Bounded global AI knowledge cleanup](../docs/decisions/0050-bounded-global-knowledge-cleanup.md).
