# Repository knowledge agent workflow

<!-- markdownlint-disable MD013 -->

## Type

Change

## Lifecycle

Active implemented contract.

## Goal

Keep the model-facing `repo_knowledge` guidance aligned with the current idx knowledge lifecycle without pretending that compact wrapper actions provide semantic judgment or every CLI workflow.

## Scope

- The `repo_knowledge` description, prompt snippet, flattened prompt guidelines, schema, and idx argument adapter.
- Receipt-based verification through `prepare` and `verify`.
- Explicit CLI fallback for durable review obligations, CI checks, and optional manifests.
- Documentation and deterministic prompt/adapter tests.

## Non-goals

- Reimplementing every `idx wiki` subcommand as a tool action.
- Generating, completing, or approving a verification receipt on the agent's behalf.
- Inferring semantic correctness from freshness, retrieval rank, similarity, or an empty result.
- Executing commands found inside imported receipt JSON.

## Behavior

- Primary source specs/contracts remain authoritative. Summaries, embeddings, rankings, and relation candidates are routing evidence only.
- `record` classifies/indexes metadata and never constitutes semantic verification.
- `prepare` maps to `idx wiki prepare --path ...`, optionally with a selector map and a new receipt output path. Its result is an unaccepted version 1 draft.
- `verify` requires `receiptPath` plus the existing semantic-review acknowledgement and maps to `idx wiki verify --path ... --receipt ...`.
- Receipt and selector paths must remain inside the canonical project root. Absolute, parent-traversing, Windows drive-prefixed/UNC, and symlink-escaping paths are rejected before idx execution.
- Verify commands run only when the caller explicitly supplies `checks`; each maps to a separate `--check`. Commands represented in receipt JSON are never executed by the wrapper.
- A reviewer must compare the final primary source, relation map, relevant code/tests/evidence, and stated limitations before completing and accepting a receipt. Freshness records that hash-bound review state; it is not a generative semantic-correctness verdict.
- `context` and `search` remain bounded indexed retrieval. Guidance must preserve visible truncation/degradation diagnostics and must not treat empty retrieval as proof that no contract exists.
- For material behavior changes, the agent locates the governing contract, updates or creates the focused primary source in the same task, runs task-scoped impact, and reviews uncovered/new/moved documents. Similarity alone never authorizes a relation, and a reviewed no-impact decision is valid.
- Durable impact decisions use `idx wiki review collect/list/resolve` through the shell at the project root. `idx wiki check` is the deterministic unresolved-obligation gate. The compact wrapper does not invent equivalent actions.
- Optional `idx wiki manifest` commands also use the explicit CLI fallback. Manifests carry portable declarations, not verification receipts or trusted baselines.
- Every flattened `promptGuidelines` bullet names `repo_knowledge`, so each remains understandable after Pi injects the bullets without a tool-name heading.

## Related files

- `external/pi-tools-suite/src/tool-descriptions.ts`
- `external/pi-tools-suite/src/repo-discovery/index.ts`
- `external/pi-tools-suite/test/tool-descriptions.test.ts`
- `external/pi-tools-suite/test/repo-discovery.test.ts`
- `external/pi-tools-suite/README.md`

## Verification

- Tool-description tests lock the receipt lifecycle, retrieval caveats, explicit CLI fallback, and standalone guideline wording.
- Repo-discovery tests cover prepare argument mapping, receipt-required verify, repeatable explicit checks, and rejection before idx execution when the receipt is absent.
- `bun test test/tool-descriptions.test.ts test/repo-discovery.test.ts`
- `npm --prefix external/pi-tools-suite run typecheck`
- `git diff --check`
