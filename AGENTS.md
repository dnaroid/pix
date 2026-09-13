# Engineering guardrails

These rules apply to every code change, including tasks where no specialized
skill is triggered.

- **Keep files cohesive.** Do not keep appending substantial behavior to an
  already oversized or multi-responsibility hand-written file. Around 500 lines
  is a review signal; around 800+ lines, prefer a cohesive extraction before
  adding more unless the file is intentionally declarative/generated or a clear
  composition root. Split by responsibility, not arbitrary line chunks.
- **Audit UI blocking.** For code reachable from UI/events, trace the
  synchronous path. Do not perform synchronous filesystem/process/network work,
  parse/serialize operations, expensive loops/scans, or avoidable full rerenders
  on the UI/main thread. Move, chunk, cache, or defer heavy work as appropriate.
- **Audit races.** For async/reactive/background code, explicitly check
  overlapping invocations, stale/out-of-order completion, cancellation,
  teardown/session replacement, and shared mutable state. Use clear
  ownership/generation/request identity, serialization/locking, abort/cancel, or
  idempotency where appropriate.
- **Own background work.** Timers, listeners, subscriptions, requests, workers,
  and queues must have bounded lifetime/work, observable errors, and
  cleanup/cancellation on teardown. Avoid unbounded queues and fire-and-forget
  tasks with lost failures.
- **Test the dangerous interleaving.** Race-prone changes should have
  deterministic tests for overlap/out-of-order completion or teardown; avoid
  timing-only sleeps. UI changes should also be stress-checked when practical.
- **Verify before finishing.** Run focused tests/checks for the touched area
  plus `git diff --check`, and review the scoped diff for accidental complexity.

For deeper guidance, use `skills/simplify/SKILL.md` after non-trivial code edits
and `skills/playwright-cli/SKILL.md` when UI/browser interaction can be
exercised.
