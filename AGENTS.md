# Engineering guardrails

- Start with `wiki/index.md` for project documentation. New durable guides,
  requirements and specifications belong in `wiki/`, beside their subject;
  link them from the relevant section index. Follow `wiki/maintenance/index.md`.
  Keep tool-loaded instructions, package entry points and legal/provenance files
  at their required paths; do not create parallel `docs/` or `specs/` trees.
- Run full local `npm run check:ci` only for release preparation or explicit
  "запушить всё"; otherwise use focused tests and relevant typechecks/builds,
  never all gate stages separately. Preflight does not authorize a full run.
  Follow `wiki/development/guide.md#verification-before-pushing` for prerequisites
  and verification reporting.
- Treat `wiki/development/release/ci-release.md` and current CI scripts as the executable CI contract.
- Use native Code/Knowledge search; do not add fallback providers or setup gates,
  read unrelated legacy configuration, or migrate providers as part of search.
  For search changes/configuration, read `wiki/search/native-repository-search.md`.
- Store disposable output in unique run/task directories under the current
  project's `.pi/artifacts/`, never root `artifacts/` or `.artifacts/`;
  put requested deliverables at the
  requested path. Export evidence needing retention: scratch cleanup can be
  immediate. Before changing prompts, roles, examples, harness defaults or paths,
  read `wiki/operations/harness-artifact-storage.md` for layout, exceptions and propagation.
- For Desktop work, follow the macOS-only scope in `wiki/development/guide.md`.
  Follow `wiki/desktop/design.md` control rules/checks for Desktop UI changes.
- Keep hand-written files cohesive; split growing multi-responsibility files by
  ownership instead of continuing to append unrelated behavior.
- Send meaningful handled errors and recoverable warnings to the existing
  diagnostic logger, even when shown in the UI; follow `wiki/operations/logging.md`.
- For UI/event code, avoid blocking work and heavy synchronous work on the
  UI/main thread.
- For async/reactive/background code, check races, stale completion,
  cancellation, teardown, and shared mutable state. Release subscriptions,
  listeners, timers, and other owned resources; avoid memory leaks and unintended
  retention after teardown.
- Add deterministic tests for dangerous concurrency/lifecycle cases when the
  change is race-prone.
