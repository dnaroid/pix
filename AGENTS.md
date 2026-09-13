# Engineering guardrails

- Keep hand-written files cohesive; split growing multi-responsibility files by
  ownership instead of continuing to append unrelated behavior.
- For UI/event code, check the synchronous path for blocking work and avoid heavy
  work on the UI/main thread.
- For async/reactive/background code, check races, stale completion,
  cancellation, teardown, and shared mutable state.
- Add deterministic tests for dangerous concurrency/lifecycle cases when the
  change is race-prone.
