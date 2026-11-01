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

Keep model-facing repository discovery aligned with native search and documentation
maintenance, without treating generated answers as semantic proof.

## Scope

- Repo-aware tool descriptions, prompt guidance, schemas and search options.
- General coding discovery, document/contract retrieval, and task-scoped audit.
- Documentation and deterministic prompt/adapter tests.

## Behavior

- `repo_context`, `repo_inspect`, `repo_audit`, and `repo_search` are removed.
  Code and Knowledge use native `project_search` across Pi/TUI/ACP/Desktop;
  there is no external-backend fallback, setup/update command, panel, provider migration or
  repository-search gate. See [Project-wide agent search](project-search-agent-tool.md).
- Native lexical retrieval needs no embedding credentials. Opt-in repository and
  commit embeddings use the global `search.embedding` object in
  `~/.config/pi/pi-tools-suite.jsonc` (legacy `.pi/search/semantic.json` is
  ignored); chunks/queries may be transmitted externally.
- The primary bundled extension exposes `project_search` with its full schema to
  ordinary Pi, ACP, and every async child/provider child/council. Every caller has
  the same sources (`sessions`, `tasks`, `commits`, `code`, `knowledge`), options,
  and `patch:<literal>` behavior; there is no child restriction or reduced facade.
  Children still omit suite setup commands and parent orchestration/delegation
  guidance, and retain their normal work-tool restrictions. `project_search` does
  not initialize or update external search services. Repository embeddings are
  authorized only by that saved global configuration, with no separate consent
  step, and keep the same provider safeguards. See [decision 0060](../decisions/0060-subagent-read-only-repo-tools.md)
  and [project search](project-search-agent-tool.md).
- `project_search` is the single project retrieval tool. It defaults to all five
  sources for every caller; choose sources explicitly to narrow scope. Code and
  Knowledge use native search; unsupported legacy filters are removed from the
  schema. See its spec for supported options and privacy details. Markdown
  documents are searched subject to ignore/exclusion filters. Explicit frontmatter
  kind/status takes precedence; inferred purpose is advisory.
- Preserve visible warnings, truncation and continuation hints. Empty or degraded
  retrieval does not establish the absence of a contract. Read authoritative
  primary documents and relevant code/tests rather than trusting summaries or
  rankings as semantic proof.
- Start compact. Use `project_search` to locate relevant contracts, code and tests,
  initially with at most 3 results and no inline content. For maps, inventories,
  symbols or dependencies, use available file/path and structural tools as useful;
  `project_search` is retrieval, not an architecture/dependency graph. Read exact
  returned ranges directly; only
  expand for a named gap. Exact identifier/text lookup uses available `Grep`/`grep`,
  otherwise shell `rg`; path-only discovery uses available `Glob`/`find`, otherwise
  shell `rg --files`. Read known paths directly; never require an unavailable tool.
  These text-only fallbacks do not weaken AST-first routing for structural queries.
- Being new to a repository alone does not request an architecture map: a
  reading guide for a behavior starts with `project_search` and direct reads.
  Before creating a spec or making a material behavior change, use
  `project_search` to locate the contract and evidence, then read primary sources.
  Keep the governing
  document's behavior/scenarios/constraints/interfaces aligned in
  the same task; create a focused spec only if needed. New specs use the
  project's documentation location, authoring rules and spec template when
  present, with `kind: spec` and intended `status`. Describe behavior,
  constraints and verification outcomes rather than catalogues of source/test
  paths. Keep exact paths for documented actions, contracts or historical
  evidence. If the template is absent, ask before creating one rather than
  inventing a convention.
  Existing useful documents do not need reformatting.
- Before completing an implementation task, the parent runs the available
  `knowledge-auditor` with the final behavior/result and exact task-changed
  project-relative paths. Obtain the result and resolve concrete documentation
  questions; the parent retains product and architecture decisions.
- The docs-only specialist updates affected specs/README material using the final
  implementation and tests as evidence. It fixes small, unambiguous drift and
  returns substantial or ambiguous discrepancies to the parent. Accurate
  documentation needs no edit. If the role is unavailable, the parent maintains
  affected documentation directly.
- Documentation maintenance does not require search setup. The bundled
  role has no indexed-project visibility gate. Search and direct reads are
  sufficient; retrieval results are not evidence of semantic correctness.
- Do not require `idx knowledge dirty`, `idx knowledge acknowledge`, index
  refreshes, review receipts, a global clean verdict, or exhaustive traversal of
  every declared Implementation/Tests dependency. Read only the evidence needed
  to resolve the task's documentation questions. Unrelated
  knowledge state do not block this work.
- The same role accepts an explicitly assigned **spec-review** with exact
  documentation paths and a review goal. This is bounded documentation work,
  not global cleanup or certification; changed product paths are not required.
- Preserve unrelated and concurrent edits. An unassigned document with existing
  local edits is a conflict to report, not permission to overwrite it. Re-read
  changed documentation before applying patches.
- Return documentation updated/no changes needed, exact documentation paths
  changed and unresolved questions with evidence. Do not produce a global
  dirtiness verdict or dependency-coverage ledger. Source/test/configuration
  changes remain outside the role; disposable reports use `.pi/artifacts/`.

## Decision history

Rationale: [0002 — Agent-owned decision history](../decisions/0002-agent-owned-decision-history.md).
Current finalization: [0067 — Final documentation maintenance without knowledge-state gates](../decisions/0067-final-documentation-maintenance.md).
Historical: [0046 — Task-scoped knowledge audit completion](../decisions/0046-task-scoped-knowledge-completion.md).

- Specs remain the current behavior contract; `docs/decisions/` records why
  significant choices were made. Use the project's convention and template,
  not the spec template or an invented idx document kind. This repository uses
  [the decision log](../decisions/README.md) and its
  [template](../decisions/TEMPLATE.md). Ordinary Markdown retrieval applies;
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

## Verification

- Tests cover supported command routing, bounded defaults, input validation,
  removal of obsolete wiki actions/flags, and model-facing guidance.
- The opt-in live tool-selection suite uses isolated native-search fixtures
  with real model calls. It retains the focused-search, contract,
  architecture, audit-fallback and session/compression assertions; deterministic
  fixture tests cover root isolation, parser compatibility and child cleanup.
- `npm --prefix external/pi-tools-suite run typecheck`
- `git diff --check`
- `npm --prefix external/pi-tools-suite run test:evals:contracts` checks the
  decision-policy validators. The opt-in eight-case `decision.*` live slice
  described in [eval docs](../development/testing/evals.md) observes the
  current parent/auditor recording threshold against completed-work fixtures.
  It checks declared actions plus actual records, links, and historical
  preservation; it is not full audit/subagent execution or an LLM judgment of
  rationale truth. Inspect retained output for fabricated alternatives/claims.

<!-- pix:wiki-check {"version":1,"status":"clear","contentHash":"f93f9d46c0e639f826c9994ec3714714fa9166d16ab20644f70a9e8da7334c81","checkedAt":"2026-10-31T00:49:11.292Z","modelRef":"zai/glm-5.3-flash","scope":"retrieved-passages","checkedSources":12,"candidateSources":69,"reportLanguage":"ru"} -->
