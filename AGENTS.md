# Engineering guardrails

- Pix Desktop currently supports macOS only. Existing Windows/Linux Desktop
  packaging code does not imply supported products; do not treat their validation
  as a current Desktop delivery requirement. This does not change TUI platform support.
- Keep hand-written files cohesive; split growing multi-responsibility files by
  ownership instead of continuing to append unrelated behavior.
- For UI/event code, check the synchronous path for blocking work and avoid heavy
  work on the UI/main thread.
- For async/reactive/background code, check races, stale completion,
  cancellation, teardown, and shared mutable state.
- Add deterministic tests for dangerous concurrency/lifecycle cases when the
  change is race-prone.
- Before changing DCP full-history reads or retry validation, read
  `specs/dcp-statistics.md#lazy-tail-retry-invariant`. Lazy `getBranch()` is a
  partial JSONL presentation tail, not pure ancestry. Keep both the positive
  real-lazy startup/append regression and the negative fork-lineage checks;
  positional comparison or ID membership alone must not replace parent-link proof.
