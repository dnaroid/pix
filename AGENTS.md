# Engineering guardrails

- Keep hand-written files cohesive; split growing multi-responsibility files by
  ownership instead of continuing to append unrelated behavior.
- For UI/event code, check the synchronous path for blocking work and avoid heavy
  work on the UI/main thread.
- For async/reactive/background code, check races, stale completion,
  cancellation, teardown, and shared mutable state.
- Add deterministic tests for dangerous concurrency/lifecycle cases when the
  change is race-prone.
- Put agent/review/verification scratch output under `.pi/artifacts/` (or
  another appropriate `.pi/` subdirectory). Do not create a repository-root
  `artifacts/` directory. The existing `.artifacts/` paths are reserved for
  build/release tooling.
- Before changing DCP full-history reads or retry validation, read
  `specs/dcp-statistics.md#lazy-tail-retry-invariant`. Lazy `getBranch()` is a
  partial JSONL presentation tail, not pure ancestry. Keep both the positive
  real-lazy startup/append regression and the negative fork-lineage checks;
  positional comparison or ID membership alone must not replace parent-link proof.
