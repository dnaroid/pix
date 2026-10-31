# 0015 — Canonical disposable harness output

- Status: accepted
- Recorded: 2026-10-03
- Decided: 2026-10-03
- Owner / approval evidence: user requested fixing all artifact-path guidance,
  documenting it for future prompts, and using a shared path constant in this task.
- Governing spec: [Harness artifact storage](../operations/harness-artifact-storage.md)
- Replaces / replaced by: none

## Context

Ambiguous artifact guidance can produce disposable files outside the existing
project cleanup boundary. The fix must preserve release outputs, user
deliverables and existing files with unknown authorship.

## Observations and sources

- The generic child prompt said only “in artifacts”; shared shell guidance did
  not specify a log directory. These are direct source observations before this fix.
- Five eval entrypoints defaulted to `test/evals/artifacts`, outside the
  [Registry cleanup boundary](../work-management/registry/resource-registry-project-state.md).
- At the time, the verify profile already used `.pi/artifacts/` and QA runner
  evidence used `.pi/subagents/`. Release scripts intentionally use `.artifacts/`.
- This investigation does not prove who created prior root artifacts.

## Decision

Use `.pi/artifacts/` for disposable harness output and share the project-relative
constant across generated guidance and eval defaults. Resolve eval output from
the caller's current project, not the installed suite path. Preserve explicit
overrides, harness-owned `.pi/subagents/` evidence, release/build paths and
user-requested deliverables. Document authoring rules in `AGENTS.md`, the spec
and suite docs. Do not cache absolute workspace paths or delete old artifacts.

Current classification after [0072](0072-session-native-subagents.md): child
transcripts, parent state and unretired owned-launch records belong under
`.pi/subagents/`; new disposable QA/browser evidence belongs under
`.pi/artifacts/subagents/`. Preserving existing evidence at its original path
does not make `.pi/subagents/` the default for new disposable output.

## Alternatives

- Root `artifacts/`: outside established cleanup and pollutes the working tree.
- Release `.artifacts/`: conflates disposable agent output with build products.
- Absolute cached output root: stale after workspace switches.
- Hard filesystem enforcement or migration of existing files: out of scope;
  conflicts with explicit output overrides and uncertain prior provenance.

## Consequences

Default scratch output is eligible for existing Desktop cleanup. Retained
evidence must be exported. Standalone Pi does not gain automatic TTL cleanup.
Prompt guidance is not enforcement; model compliance needs empirical checks.
Custom prompt overrides must carry the rule themselves.

## Revisit when

New harnesses write outside these defaults, models repeatedly ignore guidance,
or evidence retention/workspace ownership requires stronger path enforcement.

<!-- pix:wiki-check {"version":1,"status":"clear","contentHash":"22ae6ff18c6f13ad2e41f01aea0c31022c2a97f7a0caf63d1b10c71fbc71effa","checkedAt":"2026-10-31T13:26:08.667Z","modelRef":"zai/glm-5.3-flash","scope":"retrieved-passages","checkedSources":12,"candidateSources":64,"reportLanguage":"ru"} -->
