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

- Repo-aware tools are available only with indexed project state and an executable
  `idx`. Setup and indexing remain explicit operations.
- `repo_context` is the first choice for general behavior/task discovery. It
  retrieves bounded project behavior, documents, implementation and tests; the
  parent model reasons directly over that evidence rather than delegating to a
  second repository-answer model.
- `repo_search` finds documents alongside code and is the focused lookup path,
  including lexical mode when semantic retrieval is unavailable. There is
  no secondary document collection or `--include-secondary` option. All Markdown
  documents are indexed subject to ignore/exclusion filters. Explicit frontmatter
  kind/status takes precedence; inferred purpose is advisory.
- Preserve visible warnings, truncation and continuation hints. Empty or degraded
  retrieval does not establish the absence of a contract. Read authoritative
  primary documents and relevant code/tests rather than trusting summaries or
  rankings as semantic proof.
- Start compact. For an unfamiliar area use architecture; for a directory inventory
  use structure with at most 20 files/depth 2; for a known large file use a compact
  AST outline. Search behavior with at most 3 results and no inline content in
  the first pass. For a known symbol use file-scoped explain; for dependencies
  use one direction and depth 1. Read exact returned ranges directly; only
  expand for a named gap. Exact path/identifier lookup uses direct file tools.
- Before a material behavior change, find the governing document with context or
  search. Keep its behavior/scenarios/constraints/interfaces aligned in
  the same task; create a focused spec only if needed. New specs use the
  non-overwriting template installed by `idx init` at
  `.indexer-cli/spec-template.md`, with `kind: spec` and intended `status`, and
  project-root-relative paths in Implementation/Tests sections. If the template
  is absent, ask before running setup rather than inventing one.
  Existing useful documents do not need reformatting.
- After a material change, `repo_audit` receives task-scoped changed paths.
  Compare affected documents against final source and tests and fix actual
  semantic drift. Audit candidates are not proof of drift, and a reviewed
  no-impact decision is valid. Mechanical/non-behavioral changes skip this step.
- Async-subagents ships a built-in `knowledge-auditor` role for the final
  post-implementation knowledge pass. Its `requiresIndexedProject: true` gate
  makes it visible only when the project root contains `.indexer-cli/`;
  visibility does not depend on `idx` being executable. The parent gives it a
  concise behavior/result summary plus exact task-changed project-relative
  paths. It runs `idx audit` through its shell, fixes only small unambiguous
  documentation drift grounded in final code/tests, refreshes the index after
  edits, and escalates substantial/ambiguous/new-contract work without guessing.
- When `knowledge-auditor` is effective, the final audit responsibility is
  delegated to it instead of spending the parent model on routine drift cleanup.
  The parent retains decisions and handles escalations. If the role is disabled
  or unavailable, the existing parent-owned `repo_audit` workflow remains the
  fallback.

## Related files

- `external/pi-tools-suite/src/tool-descriptions.ts`
- `external/pi-tools-suite/src/repo-discovery/index.ts`
- `external/pi-tools-suite/src/async-subagents/agents/knowledge-auditor.md`
- `external/pi-tools-suite/src/async-subagents/core/config.ts`
- `external/pi-tools-suite/test/tool-descriptions.test.ts`
- `external/pi-tools-suite/test/repo-discovery.test.ts`
- `external/pi-tools-suite/README.md`

## Verification

- Tests cover supported command routing, bounded defaults, input validation,
  removal of obsolete wiki actions/flags, and model-facing guidance.
- `bun test test/tool-descriptions.test.ts test/repo-discovery.test.ts`
- `npm --prefix external/pi-tools-suite run typecheck`
- `git diff --check`
