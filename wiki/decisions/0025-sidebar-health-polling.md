# 0025 — Sparse read-only sidebar health

- Status: accepted
- Recorded: 2026-10-03
- Decided: 2026-10-03
- Owner / approval evidence: implementing agent under the user's request to verify cheap, nonblocking, race/leak-safe sidebar health. Scheduling and conservative revision inference are implementation choices, not separately user-approved UX.
- Governing spec: [sidebar indicators](../desktop/workbench/desktop-sidebar-indicators.md); related [Git](../desktop/integrations/desktop-git-workflows.md)
- Replaces / replaced by: none

## Context

Closed-panel indicators were required to include CI failure and planned tasks without duplicating panel timers or fetching repositories. Clauses specific to the removed external index integration have been removed from this historical record; the remaining scheduling rationale is retained.

## Observations and sources

- Repository evidence: sidebar polling had separate local and remote lanes alongside the removed index-integration lane; Git CI already serialized exact-HEAD queries and owned cancellation. See the governing specs and their implementation/test lists.
- User-reported requirement: Tasks should indicate planned tasks, not completed tasks.
- Focused regression tests cover teardown, coalescing, sparse cadence, explicit verdicts and process cleanup. They are not proof of live remote CI/auth availability or semantic knowledge correctness.

## Decision

- Reuse the remote sidebar lane (60 seconds foreground / 5 minutes background) for inactive Git CI status only; keep panel cadence and lazy job requests separate.
- Prune/cap Registry cache and CI run caches.

## Alternatives

- Always poll full panels: duplicates timers/detail requests and makes closed views more expensive.

## Consequences

Closed panels gained explicit signals with existing sparse scheduling. Checks remained off the UI thread, serialized and bounded, but this did not constitute a latency benchmark or guarantee against filesystem stalls.

## Revisit when

The sidebar health contract or Git CI recovery/cadence needs change.
