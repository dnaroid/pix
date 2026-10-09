---
kind: spec
status: active
---

# Indexed repository discovery and audit workflow

<!-- markdownlint-disable MD013 -->

## Type

Change

## Lifecycle

Active implemented contract.

## Goal

Keep model-facing repository discovery aligned with the current idx commands,
without treating generated answers or audit candidates as semantic proof.

## Scope

- Repo-aware tool descriptions, prompt guidance, schemas, and idx argument adapters.
- General coding discovery, document/contract retrieval, and task-scoped audit.
- Documentation and deterministic prompt/adapter tests.

## Behavior

- IDX-backed `repo_*` tools are available only with indexed project state and
  an executable `idx`. Setup and indexing remain explicit operations.
  The separate read-only `project_search` tool is available even without IDX,
  searching saved Sessions, Tasks and HEAD Git commits locally, with optional
  IDX Code/Knowledge lookup when that index is already available.
  See [Project-wide agent search](project-search-agent-tool.md).
- `/idx-init` defaults to OpenRouter `perplexity/pplx-embed-v1-0.6b` embeddings
  at 1024 dimensions for code and documents, requiring `OPENROUTER_API_KEY` or
  `~/.config/idx/.env`. Agent-facing initialization guidance discloses that
  chunks and queries leave the machine and offers `/idx-init --embedding local`
  as an explicit alternative: local Ollama `jina-8k` for code and
  `nomic-embed-text-v2-moe` for documents at 768 dimensions. Local embedding
  requests do not require a key. Index storage stays local in both modes;
  in OpenRouter mode code/document chunks and search queries are sent externally.
  `/idx-init` accepts only the strict optional
  `--embedding local|openrouter` form; it does not switch an already-indexed
  project's saved provider implicitly. Running `idx init` without an override
  preserves saved provider settings and does not migrate them. npm installation
  of `indexer-cli` needs no key; upstream setup defaults to cloud, requires a
  cloud key, and skips Ollama setup. `idx doctor` defaults to saved providers (both
  prerequisites for a mixed set of selected projects), or cloud when no projects exist.
  Explicit `--embedding local|openrouter` checks prerequisites before deleting
  and reinitializing; provider switches rebuild the index. Agents must not read
  credentials, initialize implicitly, or silently migrate saved providers.
- All async child roles receive exactly three `repo_*` query tools
  (`repo_context`, `repo_inspect`, `repo_audit`) and a restricted
  `project_search` (Code/Knowledge only) through a common tools-only
  entrypoint when the same IDX prerequisites hold. It omits setup/update
  commands and parent delegation instructions; role work-tool restrictions and
  parent-only tool guards remain intact. Empty selections still allow private
  todo and gated repo queries. See [decision 0060](../docs/decisions/0060-subagent-read-only-repo-tools.md).
- Every `repo_*` tool accepts optional `projectPath`: an explicit project root
  (absolute, relative to the call's session cwd, or `~/`). Without it, current
  project discovery is unchanged. With it, `.indexer-cli` must exist directly in
  that directory; invalid/missing/unindexed roots fail without ancestor fallback,
  implicit setup, or changes to session cwd. Targets, scopes and audit paths refer
  to the selected project. Both output profiles support this parameter, and idx
  calls are queued by selected root. The launch-project registration gate remains
  unchanged; this parameter selects another project once tools are available.
- Model-facing tool guidance directs agents to pass `projectPath` for tasks in
  another project, omit it for the current project, and retain the selected root
  across related `repo_*` calls. Targets/scopes/audit paths are relative to that
  root; subsequent file reads resolve returned paths against it, not session cwd.
  Guidance must not encourage implicit index setup.
- `repo_context` is the first choice for general behavior/task discovery. It
  retrieves bounded project behavior, documents, implementation and tests; the
  parent model reasons directly over that evidence rather than delegating to a
  second repository-answer model.
  A focused code-path lookup or diagnosis of one implementation detail starts
  with `project_search`, even when the owner is unknown; it does not need a
  `repo_context` preflight. General orientation and authoritative contract
  assembly remain `repo_context` tasks.
- `repo_inspect` consolidates architecture, structure, AST, symbol explanation
  and dependency views behind required `mode: architecture|structure|ast|explain|deps`
  and typed options; it accepts no raw argument string. `target` is required for
  AST, explain and deps. Project-relative `scope` is supported for architecture,
  structure and explain. `limit` means max-files for structure, max-nodes for AST
  and body-lines for explain; `depth` applies to structure, AST and deps, while
  `cursor` applies to structure and AST. Structure additionally supports `kind`,
  `includeInternal` and `tests: include|exclude|summary`; deps supports
  `tests: include`, `relations: modules|module-imports|calls|call-graph`,
  `direction: callers|callees|both` and `showEdges`. Explain is signature-only
  unless `includeBody` is true. Compact defaults are structure `limit:20, depth:2`,
  AST `limit:40, depth:3`, explanation body limit 20, and dependencies
  `depth:1, direction:callers`. All tools retain `projectPath`, `maxLines` and
  `maxBytes`; `outputMode` is native-only.
- `project_search` replaces `repo_search` as the single focused search tool.
  Select `sources:["code","knowledge"]` for indexed code/documents, and use
  `indexMode` (hybrid/semantic/lexical/symbol), `pathPrefix`, chunk types,
  includeContent, deduplication, minScore, and test filters when needed.
  Search works locally over sessions/tasks/commits even without IDX, while
  IDX-only options require a preexisting index and IDX executable.
  There is no second document collection or `--include-secondary` option.
  Markdown documents are indexed subject to ignore/exclusion filters.
  Explicit frontmatter kind/status takes precedence; inferred purpose is advisory.
- Preserve visible warnings, truncation and continuation hints. Empty or degraded
  retrieval does not establish the absence of a contract. Read authoritative
  primary documents and relevant code/tests rather than trusting summaries or
  rankings as semantic proof.
- Start compact. For a high-level map or cross-module onboarding overview, start
  with architecture rather than structure; for a directory inventory
  use structure with at most 20 files/depth 2; for a known large file use a compact
  AST outline. Search behavior with at most 3 results and no inline content in
  the first pass using `project_search` with Code/Knowledge sources.
  For a known symbol use file-scoped explain; for dependencies
  use one direction and depth 1. Read exact returned ranges directly; only
  expand for a named gap. Exact identifier/text lookup uses available `Grep`/`grep`,
  otherwise shell `rg`; path-only discovery uses available `Glob`/`find`, otherwise
  shell `rg --files`. Read known paths directly; never require an unavailable tool.
  These text-only fallbacks do not weaken AST-first routing for structural queries.
- Being new to a repository alone does not request an architecture map: a
  reading guide for a behavior starts with `repo_context`. Before creating a
  spec or making a material behavior change, start contract discovery with
  `repo_context`, then use focused search for remaining gaps. Keep the governing
  document's behavior/scenarios/constraints/interfaces aligned in
  the same task; create a focused spec only if needed. New specs use the
  non-overwriting template installed by `idx init` at
  `.indexer-cli/spec-template.md`, with `kind: spec` and intended `status`, and
  project-root-relative paths in Implementation/Tests sections. If the template
  is absent, ask before running setup rather than inventing one.
  Existing useful documents do not need reformatting.
- After a material change, `repo_audit` receives task-scoped changed paths.
  Compare affected documents against final source and tests and fix actual
  semantic drift. Audit candidates are not proof of drift, and a reviewed
  no-impact decision is valid. Mechanical changes still need review-state
  checks; they do not require inventing a new behavioral contract.
- Async-subagents ships a built-in `knowledge-auditor` role for the final
  post-implementation knowledge pass. Its `requiresIndexedProject: true` gate
  makes it visible only when the project root contains `.indexer-cli/`;
  visibility does not depend on `idx` being executable. The parent gives it a
  concise behavior/result summary plus exact task-changed project-relative
  paths. It runs `idx audit` through its shell, fixes only small unambiguous
  documentation drift grounded in final code/tests, refreshes the index after
  edits, and escalates substantial/ambiguous/new-contract work without guessing.
- The same docs-only specialist supports explicit **spec-review** mode for
  bounded slices of global knowledge cleanup. The parent supplies exact spec
  paths, review goal and pass budget; changed product paths are not required.
  The child reads assigned specs, applicable decisions and every declared
  Implementation/Tests dependency, reports actual coverage/gaps, and may fix
  only small proven documentation drift. Commands and disposable report/log
  writes use its existing tools; reports live in unique target-project
  `.pi/artifacts/` directories. It returns one bounded result, not a global
  cleanup loop, and never acknowledges in this mode. Final acknowledgment is
  parent-owned after integrated, stable coverage. Default task-audit behavior
  remains unchanged; incompatible project-local replacements require fallback
  to the parent, not a tool override that bypasses role instructions.
- In both auditor modes, explicit knowledge/index lock contention is temporary:
  another agent in a parallel session may be writing to the same knowledge base.
  Wait 5 seconds and retry the same command, with at most 60 seconds of total
  waiting per blocked operation; resume immediately on success. A lock-related
  skip, including `idx index --skip-if-locked` exiting 0, is not completion and
  requires the same bounded retry. Do not retry unrelated errors, delete or
  force-release locks, kill owners, or bypass locking. On budget exhaustion,
  return a blocker with the command, diagnostic, elapsed waiting and last exit
  code. Lock release does not waive concurrent-content rechecks or mode-specific
  acknowledgment restrictions.
- When `knowledge-auditor` is effective, the final audit responsibility is
  delegated to it instead of spending the parent model on routine drift cleanup.
  The parent retains decisions and handles escalations. If the role is disabled
  or unavailable, the existing parent-owned `repo_audit` workflow remains the
  fallback.
- Finalization requires obtaining the audit result, not merely spawning the
  auditor. After all final edits, close task-related drift, escalations and
  uncovered spec dependencies, or explicitly report blockers. The auditor or
  parent fallback checks `idx knowledge dirty`, acknowledges only explicit
  active specs reviewed against current content and every declared
  Implementation/Tests dependency with `idx knowledge acknowledge`, then
  rechecks dirty. Audit, indexing and passing tests alone do not acknowledge
  review. Later dependency edits require re-review. Report remaining dirty
  state/check errors; unrelated specs must not be acknowledged to force `no`.
- Task audit completion and global knowledge cleanliness are separate verdicts.
  Report `task audit: passed | blocked` and `global knowledge dirty: yes | no |
  unknown` with check errors/exit codes. The audit todo closes once this task's
  changes and genuinely affected specs are reviewed, drift/escalations resolved,
  required dependency coverage complete, and eligible acknowledgments successful
  (or a reviewed no-impact result explains why none is needed). A global `yes`
  alone, even with an unclassified cause, is not a task blocker or proof that
  the remaining dirtiness is unrelated. Global-check errors remain visible and
  block task review only if they prevent establishing its evidence. A global
  clean claim still requires a successful complete `no` check.
- Parallel edits outside reviewed specs/dependencies do not require waiting or
  re-review. Edits to a reviewed spec or its dependencies, including shared files,
  invalidate that review and require resolution before acknowledging it or
  closing the audit todo. Do not expand task scope to clear global dirtiness.

## Decision history

Rationale: [0002 — Agent-owned decision history](../docs/decisions/0002-agent-owned-decision-history.md).
Audit completion: [0046 — Task-scoped knowledge audit completion](../docs/decisions/0046-task-scoped-knowledge-completion.md).

- Specs remain the current behavior contract; `docs/decisions/` records why
  significant choices were made. Use the project's convention and template,
  not the spec template or an invented idx document kind. This repository uses
  [the decision log](../docs/decisions/README.md) and its
  [template](../docs/decisions/TEMPLATE.md). Ordinary Markdown retrieval applies;
  this does not introduce a database or runtime enforcement.
- Before significant changes, read linked decisions and, when needed, search
  the decision directory. Check status and replacement links rather than
  treating historical reasoning as today's contract.
- Default to no new decision record: a feature, bug fix, UX change, implementation
  detail, dependency/model change or changed spec alone is not a trigger. Record
  an explicitly user-requested decision, or a choice that both involves materially
  different plausible alternatives, consequential accepted risk or costly reversal,
  and has durable rationale useful to avoid repeating a dispute or mistake that
  an existing record does not already capture. Ask whether that rationale will
  still be useful in six months. Do not invent alternatives to justify a record;
  link an existing applicable record instead. This threshold is prospective, not
  grounds for pruning or rewriting historical records.
- For choices meeting that threshold, the parent records rationale while context
  is available. Keep status, context,
  evidence versus assumptions, decision/scope, alternatives, consequences and
  revisit triggers; include owner/approval evidence and recording date. Specs
  and decisions link both ways. Ordinary behavior changes belong in specs;
  even material changes need no new decision record unless the threshold is met.
- Attribute reported observations, cite durable sources when available and
  disclose missing evidence; never reconstruct motives from final code. The
  parent/user owns acceptance and supersession. New decisions explicitly replace
  old records, which retain their reasoning and link to the successor.
- The parent hands decision paths and rationale (or why no new decision was
  needed) to the auditor along with normal task scope. The auditor checks
  completeness, source/assumption distinctions, status, reciprocal links and
  agreement with the current spec; missing rationale is an escalation only for
  a choice meeting the recording threshold. A justified no-record handoff is
  valid, not missing documentation. Conflicting rationale remains an escalation.
  A qualifying choice missing its record requires escalation even when rationale
  is complete; supplied rationale or a proposed path does not replace a record.
  Creating that record belongs to the parent/user, not the auditor: its outcome
  is `escalate`, never `create`.
  It may fix small proven links/typos, but never invent, accept or
  supersede decisions itself. Parent-owned fallback audits use the same checks.

## Implementation

- `external/pi-tools-suite/src/tool-descriptions.ts`
- `external/pi-tools-suite/src/project-search/index.ts`
- `external/pi-tools-suite/src/repo-discovery/index.ts`
- `external/pi-tools-suite/src/repo-discovery/inspect.ts`
- `external/pi-tools-suite/src/repo-discovery/native-compact.ts`
- `external/pi-tools-suite/test/fixtures/hard-to-find-project/benchmark/run-locate-benchmark.mjs`
- `external/pi-tools-suite/src/repo-discovery/subagent.ts`
- `external/pi-tools-suite/src/async-subagents/core/child-tools.ts`
- `external/pi-tools-suite/src/async-subagents/core/spawn.ts`
- `external/pi-tools-suite/src/async-subagents/agents/knowledge-auditor.md`
- `external/pi-tools-suite/src/async-subagents/core/config.ts`
- `external/pi-tools-suite/src/async-subagents/core/agent-catalog.ts`
- `external/pi-tools-suite/src/todo/index.ts`
- `external/pi-tools-suite/README.md`

## Tests

- `external/pi-tools-suite/test/tool-descriptions.test.ts`
- `external/pi-tools-suite/test/tool-selection-e2e.test.ts`
- `external/pi-tools-suite/test/tool-selection-fixture.test.ts`
- `external/pi-tools-suite/test/tool-selection-fixture.ts`
- `external/pi-tools-suite/test/tool-selection-process.ts`
- `external/pi-tools-suite/test/fixtures/tool-selection-idx.mjs`
- `external/pi-tools-suite/test/fixtures/tool-selection-spec-template.md`
- `external/pi-tools-suite/test/fixtures/tool-selection-payment-retry.md`
- `external/pi-tools-suite/test/async-subagents/knowledge-auditor.test.ts`
- `external/pi-tools-suite/test/todo.test.ts`
- `external/pi-tools-suite/test/repo-discovery.test.ts`
- `external/pi-tools-suite/test/repo-native-compact.test.ts`
- `external/pi-tools-suite/test/fixtures/hard-to-find-project/README.md`
- `external/pi-tools-suite/README.md`
- `external/pi-tools-suite/test/async-subagents/repo-tools.test.ts`
- `external/pi-tools-suite/test/async-subagents/provider-child-inventory.test.ts`
- `external/pi-tools-suite/test/evals/decision-policy.ts`
- `external/pi-tools-suite/test/evals/decision-policy.test.ts`
- `external/pi-tools-suite/test/evals/fixtures/decision-policy/`
- `external/pi-tools-suite/test/evals/cases.ts`
- `external/pi-tools-suite/test/evals/coverage-manifest.ts`
- `external/pi-tools-suite/test/evals/harness/types.ts`
- `external/pi-tools-suite/test/evals/harness/runner.ts`

## Verification

- Tests cover supported command routing, bounded defaults, input validation,
  removal of obsolete wiki actions/flags, and model-facing guidance.
- The opt-in live tool-selection suite uses isolated fixtures and simulated IDX
  responses with real model calls. It retains the focused-search, contract,
  architecture, audit-fallback and session/compression assertions; deterministic
  fixture tests cover root isolation, parser compatibility and child cleanup.
- `bun test test/tool-descriptions.test.ts test/repo-discovery.test.ts`
- `npm --prefix external/pi-tools-suite run typecheck`
- `git diff --check`
- `npm --prefix external/pi-tools-suite run test:evals:contracts` checks the
  decision-policy validators. The opt-in eight-case `decision.*` live slice
  described in [eval docs](../external/pi-tools-suite/docs/evals.md) observes the
  current parent/auditor recording threshold against completed-work fixtures.
  It checks declared actions plus actual records, links, and historical
  preservation; it is not full audit/subagent execution or an LLM judgment of
  rationale truth. Inspect retained output for fabricated alternatives/claims.
