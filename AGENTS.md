# Engineering guardrails

- Pix Desktop currently supports macOS only. Existing Windows/Linux Desktop
  packaging code does not imply supported products; do not treat their validation
  as a current Desktop delivery requirement. This does not change TUI platform support.
- Keep hand-written files cohesive; split growing multi-responsibility files by
  ownership instead of continuing to append unrelated behavior.
- For UI/event code, avoid blocking work and heavy synchronous work on the
  UI/main thread.
- For async/reactive/background code, check races, stale completion,
  cancellation, teardown, and shared mutable state. Release subscriptions,
  listeners, timers, and other owned resources; avoid memory leaks and unintended
  retention after teardown.
- Add deterministic tests for dangerous concurrency/lifecycle cases when the
  change is race-prone.
