# 0025 — Sparse read-only sidebar health

- Status: accepted
- Recorded: 2026-10-03
- Decided: 2026-10-03
- Owner / approval evidence: implementing agent under the user's request to verify cheap, nonblocking, race/leak-safe sidebar health. Scheduling and conservative revision inference are implementation choices, not separately user-approved UX.
- Governing spec: [sidebar indicators](../../specs/desktop-sidebar-indicators.md); related [IDX](../../specs/desktop-idx-panel.md), [Git](../../specs/desktop-git-workflows.md)
- Replaces / replaced by: none

## Context

Closed-panel indicators must include CI failure, planned tasks and IDX health without duplicating panel timers, fetching repositories, running semantic audits or starting indexing.

## Observations and sources

- Repository evidence: sidebar polling already has separate local, remote and IDX lanes; Git CI already serializes exact-HEAD queries and owns cancellation. See the governing specs and their implementation/test lists.
- User-reported in this task: Tasks should indicate planned tasks, not completed tasks; `idx knowledge dirty` and `idx knowledge acknowledge` are available in newer IDX. This conversation is the source, not a durable command-version guarantee.
- Environment evidence: the installed IDX reported 2.0.13 without knowledge commands. Compatibility is required; command availability must not imply a clean verdict.
- Focused regression tests cover teardown, coalescing, sparse cadence, explicit verdicts and process cleanup. They are not proof of live remote CI/auth availability or semantic knowledge correctness.

## Decision

- Reuse the remote sidebar lane (60 seconds foreground / 5 minutes background) for inactive Git CI status only; keep panel cadence and lazy job requests separate.
- Use explicit `knowledge dirty` yes/no only after complete exit 0, with a 5-second/4-KiB budget. Unsupported command is unknown; incomplete checks are errors. Never acknowledge specs automatically.
- Warn conservatively for indexed Git revision differing from HEAD. A matching revision remains unknown for uncommitted edits; do not substitute dry-run for a cheap freshness API.
- Debounce focus-triggered IDX attempts by 30 seconds, reuse mounted-panel overview, prune/cap Registry cache and CI run caches, and clean isolated IDX descendants before joining inherited pipes.

## Alternatives

- Always poll full panels: duplicates timers/detail requests and makes closed views more expensive.
- Run audit or dry-run for every freshness sample: no bounded cheap status guarantee, and audit is not a semantic dirty verdict.
- Infer clean from missing commands or matching HEAD: misleading certainty, especially for uncommitted changes.

## Consequences

Closed panels gain explicit signals with existing sparse scheduling. Unsupported old IDX cannot show knowledge dirtiness; revision mismatch does not detect every uncommitted stale index. Existing checks remain off the UI thread, serialized and bounded, but this does not constitute a latency benchmark or guarantee against filesystem stalls.

## Revisit when

IDX exposes a cheap authoritative working-tree freshness API; knowledge command contracts change; measurements show sidebar budgets are too expensive; or live provider tests expose a CI recovery/cadence issue.
