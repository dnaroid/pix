# CI and release verification

## Scope

This spec defines the release CI invariants for Pix. It covers the cross-platform correctness matrix, packed-package smoke coverage, deterministic-test requirements, and Windows process-cleanup rules that must remain true when CI or UI-QA tests change.

## CI contract

- `build-and-test` runs on Ubuntu, macOS, and Windows and is the cross-platform correctness gate.
- The full packed-artifact smoke test runs on Ubuntu and verifies the tarball payload plus installed CLI behavior.
- Windows runs the smaller packed CLI smoke path: build, `npm pack`, isolated install, required entry/build files, and non-interactive CLI commands.
- A separate macOS package-smoke job is not required unless packaging gains macOS-specific behavior.
- Publishing remains gated on the package-smoke job and uses npm trusted publishing through GitHub OIDC.

## Deterministic test invariants

- Tests must assert explicit bytes, counts, states, or observable ownership conditions instead of assuming a runner completes enough work during a short wall-clock interval.
- Timers are appropriate only when timeout behavior itself is under test; elapsed time must not stand in for output volume, process progress, or cleanup completion.
- Process-cleanup tests wait for an observable owned-process condition when teardown completion matters.
- Local reproduction of configuration-sensitive suite tests uses an isolated `HOME` so user Pix/pi-tools-suite configuration cannot change the tested defaults.
- CRLF/LF differences are normalized unless line endings themselves are the behavior under test.

## Windows process invariants

- `@lydell/node-pty` Windows termination is signal-less: use `kill()` without POSIX signal arguments and release owned ConPTY resources.
- Windows browser/process cleanup is ownership-scoped. Cleanup helpers must not discover or terminate themselves; owned child roots are terminated recursively and cleanup is verified before returning.
- Node child-process smoke helpers invoke npm through its JavaScript entrypoint (`process.execPath` + `npm_execpath`) rather than trying to `execFile` `npm.cmd` directly.

## Package-smoke invariants

- Source tests do not replace package smoke coverage: `npm pack` must still be proven installable and runnable.
- Smoke assertions track stable package contracts such as required payload paths, entry points, and intentionally asserted guide/CLI behavior.
- When an intentionally asserted package contract changes, its smoke assertion changes in the same commit.

## Implementation

- `.github/workflows/publish.yml`
- `scripts/smoke-test-package.sh`
- `scripts/smoke-test-package-cli.mjs`
- `package.json`
- `external/pi-tools-suite/test/async-subagents/ui-qa-runner.test.ts`
- `external/pi-tools-suite/src/async-subagents/agents/ui-qa/backends/tui.mjs`
- `external/pi-tools-suite/src/async-subagents/agents/ui-qa/browser/scripts/browser-qa-runner.mjs`

## Verification

- `npm run smoke-test`
- `npm run smoke-test:cli`
- `npm run test:tools-suite` with an isolated `HOME` when reproducing CI defaults locally
- `git diff --check`

