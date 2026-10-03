# Engineering guardrails

- Store disposable task output (test logs, scratch reports, mockups, captures)
  in unique run/task directories under the current project's `.pi/artifacts/`.
  Never create project-root `artifacts/` or use `.artifacts/` for agent scratch
  output. Harness-owned subagent/QA evidence stays under `.pi/subagents/`;
  release/build pipelines keep their explicitly configured `.artifacts/` paths.
  User-requested deliverables belong at the requested path, not in disposable
  storage. Apply this rule to new prompts, role profiles, examples and harness
  defaults; custom prompt overrides must repeat it when replacing base guidance.
  Desktop cleanup is not universal: initialized-project background cleanup has
  a 72-hour TTL, and manual Clean removes scratch output immediately. Export
  evidence that must be retained. See `specs/harness-artifact-storage.md`.

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
