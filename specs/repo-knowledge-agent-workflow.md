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
- `repo_ask` is the first choice for a general coding discovery task. It calls
  read-only indexed tools and produces a cited answer. Its output budget limits
  generated text, not retrieved pages; the agent checks cited sources before
  editing. If the LLM is unavailable, use lexical `repo_search`: `ask` has no
  offline mode or cursor continuation.
- `repo_context` retrieves bounded project behavior, documents, implementation
  and tests. `repo_search` and `repo_ask` find documents alongside code. There is
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
- Before a material behavior change, find the governing document with context,
  search or ask. Keep its behavior/scenarios/constraints/interfaces aligned in
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

## Related files

- `external/pi-tools-suite/src/tool-descriptions.ts`
- `external/pi-tools-suite/src/repo-discovery/index.ts`
- `external/pi-tools-suite/test/tool-descriptions.test.ts`
- `external/pi-tools-suite/test/repo-discovery.test.ts`
- `external/pi-tools-suite/README.md`

## Verification

- Tests cover supported command routing, bounded defaults, input validation,
  removal of obsolete wiki actions/flags, and model-facing guidance.
- `bun test test/tool-descriptions.test.ts test/repo-discovery.test.ts`
- `npm --prefix external/pi-tools-suite run typecheck`
- `git diff --check`
