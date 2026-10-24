# Engineering guardrails

- Run the full local `npm run check:ci` only when preparing a release or when
  the user explicitly asks to push everything ("запушить всё"). For ordinary
  implementation, review and bug-fix tasks, run focused regression tests and
  the relevant typechecks/builds for the changed code; do not run the full gate
  or reproduce it by invoking every stage separately. A focused preflight does
  not authorize a full run. When the full gate is required, use the native-host
  prerequisites in `docs/development.md`. `npm run check` is root-only, not the
  full CI gate. Report verification scope and blocked/incomplete checks; a local
  pass does not prove other operating-system matrix legs. This local policy does
  not change automatic GitHub Actions triggers.
- For CI failures, flaky tests, cross-platform portability, workflow changes,
  or CI regressions, read `.pi/skills/ci-reliability/SKILL.md` before diagnosis.
  Treat `specs/ci-release.md` and current CI scripts as the executable contract.

- Ordinary Pi/TUI/ACP/Desktop Code and Knowledge search uses the native backend.
  Do not add fallback search providers or repository-search setup gates.
  Repository semantic/commit embeddings use `OPENROUTER_API_KEY`; do not read
  unrelated legacy configuration or migrate providers as part of search.

- Store disposable task output (test logs, scratch reports, mockups, captures)
  in unique run/task directories under the current project's `.pi/artifacts/`.
  Never create project-root `artifacts/` or use `.artifacts/` for agent scratch
  output. Subagent QA workspaces/evidence live under `.pi/artifacts/subagents/`;
  child sessions and protected owned-launch records live under `.pi/subagents/`.
  Release/build pipelines keep their explicitly configured `.artifacts/` paths.
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
- Send meaningful handled errors and recoverable warnings to the existing
  diagnostic logger (TUI/ACP/Desktop/pi-tools-suite), even when shown in the UI. Use
  appropriate levels, avoid duplicate/noisy events and sensitive payloads,
  and never let logging change operation behavior. See `specs/logging.md`.
- For UI/event code, avoid blocking work and heavy synchronous work on the
  UI/main thread.
- New or changed Desktop dropdowns MUST use Pix-styled popup/listbox components,
  not native HTML `<select>`/system menus (including `appearance-none` wrappers).
  Reuse existing controls with a Lucide chevron and keyboard/focus handling;
  exceptions require an explicit user requirement. Legacy selects are not a
  precedent. Follow `DESIGN.md#11-inputs-and-composer-ui` and keep the Desktop
  native-select regression test green.
- Desktop disclosure/accordion triggers MUST have a visible, state-rotating
  Lucide chevron in both collapsed and expanded states. Native `<summary>`
  alone is not a sufficient affordance, nor is a plus icon or counter.
  Follow `DESIGN.md#123-disclosures-and-accordions` and keep the global
  disclosure-chevron regression test green when changing Desktop UI.
- For async/reactive/background code, check races, stale completion,
  cancellation, teardown, and shared mutable state. Release subscriptions,
  listeners, timers, and other owned resources; avoid memory leaks and unintended
  retention after teardown.
- Add deterministic tests for dangerous concurrency/lifecycle cases when the
  change is race-prone.
