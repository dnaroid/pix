---
name: ci-reliability
description: >-
  Use for Pix CI failures, flaky tests, red GitHub Actions, Windows/Linux/macOS
  portability bugs, test harnesses, process cleanup races, and workflow changes.
  Also use when adding CI regression tests or validating that a PR is green
  across all platforms. Diagnose exact jobs and artifacts before editing;
  prevent recurrence rather than suppressing failures.
tags: [pix, ci, testing]
---

# Pix CI reliability workflow

This skill describes **how to investigate and prevent failures**, not the
current matrix, version pins, test totals, or timeout numbers. The authoritative
contracts are `specs/ci-release.md`, `docs/development.md`,
`.github/workflows/check.yml`, and the live package/scripts/tests. Read the
relevant sections before acting.

## Establish the failing commit and scope

1. Check `git status --short`, the current branch and the exact commit SHA.
   Preserve all unrelated, unstaged work; never use a blanket reset/stash.
2. Obtain the **latest run for the intended SHA**. Inspect every matrix job's
   conclusion, not only the overall workflow badge or earlier failing runs.
3. Download the run's uploaded CI artifacts into a unique task directory under
   `.pi/artifacts/`. Read `summary.json`, the failing step log, and relevant
   test output. Distinguish `failed`, `cancelled`, timed out and `notRun`.
4. A `check:ci` summary with `passed` does **not** imply a green GitHub job:
   final artifact upload/post-job actions or the job's wall-clock ceiling can
   still fail. Compare both status layers.
5. If a working tree contains concurrent changes, run an exact-SHA verification
   in a separate clean worktree with its own locked installs. Never present
   a dirty-tree local result as proof about the pushed commit.

## Reproduce the cause, not the symptom

- Classify whether the error comes from process lifecycle, platform filesystem,
  environment/runtime/tool discovery, timing assumptions, or formatting/bytes.
- Check Windows for case-insensitive environment keys, npm `.cmd` launch
  behavior, SQLite/NTFS file locks, ConPTY, path separators and process/job
  ownership. Check POSIX process groups, pipe teardown, ownership receipts and
  LSP sockets where relevant. Verify the actual behavior from source and logs;
  don't infer it from an OS label.
- Differentiate **signal sent**, **PID exited**, **descendants retired**,
  **pipes drained** and **durable completion receipt published**. Do not use
  one of these as proof of another.
- Prefer deterministic barriers/events/status checks to `sleep()` or strict
  elapsed-time success assertions. Keep test timeouts as generous *deadlock
  ceilings*, not performance expectations.
- Before accepting an increase to a **job** timeout, verify that the underlying
  checks succeeded and that the job actually ran out of headroom. Never merely
  increase a per-test timeout to conceal an ownership race.
- Require a regression test that fails against the original defect whenever
  practical; prove success with the fix, including cleanup/failure paths.
  Never silently exclude, skip or weaken an assertion to make CI green.

## Use the existing CI prevention tools

Read current scripts from `package.json` and source instead of copying
the precise invocation or selected tests into this skill:

- Follow the local verification scope in `AGENTS.md`: full local CI only for
  release preparation or an explicit request to push everything. Otherwise use
  focused regression tests and relevant typechecks/builds, not all gate stages
  separately. Run the short **cross-platform preflight** before an authorized
  full native gate. A focused preflight can run independently and does not
  authorize the full gate; it never replaces the complete suite.
- Keep `ci-test-contracts` passing. Its baseline is a reviewed inventory of
  preexisting risky assertions/cleanup patterns, **not** a knob to automatically
  regenerate when new code fails. Fix new warnings first.
- Use `ci-history-report` on saved action artifacts to locate repeated test
  signatures and platform/runtime trends. Aggregate observations are not proof
  that a specific failure is nondeterministic.
- When the full local gate is authorized, execute the package's native-host
  `check:ci` with the versions and prerequisites from current
  `docs/development.md` (including isolated test HOME). A local host can only
  validate its own native leg.
- After pushing, require all intended GitHub matrix jobs to complete with
  `success`. For an unavailable platform, explicitly report what is unverified
  rather than claiming a green matrix.

## Keep the fix durable

Prefer a shared lifecycle, fixture-cleanup, or command-resolution helper over
another test-specific workaround. Record the actual cause and regression in
the owning tests/source; update the primary spec and docs when the contract
changes. Avoid freezing test counts, runtimes or file inventories in this
skill: they change as the suite evolves.

When reporting, include the exact SHA, the affected jobs, the observed
failure cause, focused and native-gate verification, any remaining blocker,
and the actual GitHub Actions run URL.
