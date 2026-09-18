# CI and release verification

## Scope

This spec defines the release CI invariants for Pix. It covers the cross-platform correctness matrix, packed-package smoke coverage, deterministic-test requirements, and Windows process-cleanup rules that must remain true when CI or UI-QA tests change.

## CI contract

- `build-and-test` runs on Ubuntu, macOS, and Windows and is the cross-platform correctness gate.
- The full packed-artifact smoke test runs on Ubuntu and verifies the tarball payload plus installed CLI behavior.
- Windows runs the smaller packed CLI smoke path: build, `npm pack`, isolated install, required entry/build files, and non-interactive CLI commands.
- A separate macOS **npm** package-smoke job is not required. Portable/Tauri artifacts have their own native smoke matrix.
- Publishing remains gated on the package-smoke job and uses npm trusted publishing through GitHub OIDC.
- GitHub Release builds, shared application versions, signing, complete-asset gates and portable update behavior are governed by [`release-distribution.md`](release-distribution.md). The existing npm publish job remains independent; the draft GitHub Release waits for both npm publication and all native package builds.
- Desktop release jobs require the Tauri updater signing key and must emit the
  signed updater sidecars/bundles expected for their native target. The final
  release job generates `latest.json` only from a complete four-target matrix;
  updater signing is independent from optional Apple/Windows OS code signing.

## Node.js version contract

- `.node-version` is the exact development/build pin; `.nvmrc` must mirror it. CI selects this pin with `actions/setup-node` on Ubuntu, macOS, and Windows.
- Root `package.json` `engines.node` is the authoritative supported runtime range, currently `>=22.19.0 <25`. ACP and Desktop manifests and their lockfile root records must agree with it.
- `bin/pix.mjs` reads that range from the installed package metadata and rejects unsupported versions before loading Pix. Its dependency-free check deliberately accepts only the bounded stable range format `>=major.minor.patch <major`; prereleases and an unrecognized range format fail closed.
- The build-and-test matrix also runs the minimum supported version on Ubuntu. That matrix entry must track the lower bound in `engines.node`; this run may not silently switch to the development pin.
- npm scripts use the selected `node`/`npm` from `PATH` and must not invoke or require a version manager. The same rule applies to lifecycle hooks, builds, and tests; selecting the environment is the caller's responsibility.
- Release version synchronization preserves each JSON file's existing LF/CRLF
  convention. Windows checkouts must not fail `release:version:check` merely
  because Git materialized CRLF line endings.
- `tests/node-version.test.ts` guards pin/manifest/lockfile/CI alignment and launcher boundary behavior. Update the contract and its tests together when changing supported versions.

## Deterministic test invariants

- Tests must assert explicit bytes, counts, states, or observable ownership conditions instead of assuming a runner completes enough work during a short wall-clock interval.
- Timers are appropriate only when timeout behavior itself is under test; elapsed time must not stand in for output volume, process progress, or cleanup completion.
- Real Git/filesystem integration tests may use an explicit generous harness timeout for slow Windows runners; that timeout is only a deadlock safety ceiling, never a performance assertion.
- Resource-registry scenarios that invoke real Git share a 30-second harness ceiling, including Desktop RPC snapshot tests. Pure unit tests and the command-timeout regression retain their own limits.
- Independent browser-QA rejection scenarios that launch separate Node runners are separate tests, with fresh fixtures and per-case time budgets; they must not consume a single aggregate timeout. Keep all rejection, redaction, and cleanup assertions when splitting cases.
- Process-cleanup tests wait for an observable owned-process condition when teardown completion matters.
- Process test doubles emit their terminal lifecycle events; they must not depend on unreferenced fallback timers keeping the test runner alive across Node versions.
- Local reproduction of configuration-sensitive suite tests uses an isolated `HOME` so user Pix/pi-tools-suite configuration cannot change the tested defaults.
- CRLF/LF differences are normalized unless line endings themselves are the behavior under test.

## Windows process invariants

- `@lydell/node-pty` Windows termination is signal-less: use `kill()` without POSIX signal arguments and release owned ConPTY resources.
- Windows browser/process cleanup is ownership-scoped. Cleanup helpers must not discover or terminate themselves; owned child roots are terminated recursively and cleanup is verified before returning.
- Node child-process smoke helpers invoke npm through its JavaScript entrypoint (`process.execPath` + `npm_execpath`) rather than trying to `execFile` `npm.cmd` directly.

## Package-smoke invariants

- Source tests do not replace package smoke coverage: `npm pack` must still be proven installable and runnable.
- Smoke assertions track stable package contracts such as required payload paths, entry points, npm `bin` metadata/shims, and intentionally asserted guide/CLI behavior.
- Pix CLI bin targets use npm-normalized package-relative paths (`bin/pix.mjs`, without a leading `./`) so npm 12 does not strip them during publish normalization.
- When an intentionally asserted package contract changes, its smoke assertion changes in the same commit.

## Implementation

- `.github/workflows/check.yml`
- `.github/workflows/pr-check.yml`
- `.github/workflows/publish.yml`
- `scripts/smoke-test-package.sh`
- `scripts/smoke-test-package-cli.mjs`
- `package.json`
- `.node-version`
- `.nvmrc`
- `acp/package.json`
- `acp/package-lock.json`
- `desktop/package.json`
- `desktop/package-lock.json`
- `package-lock.json`
- `bin/pix.mjs`
- `tests/node-version.test.ts`
- `tests/voice-controller.test.ts`
- `acp/test/git-assistant.test.ts`
- `external/pi-tools-suite/test/async-subagents/ui-qa-runner.test.ts`
- `external/pi-tools-suite/test/async-subagents/browser-qa-runner.test.ts`
- `external/pi-tools-suite/test/resource-registry.test.ts`
- `external/pi-tools-suite/src/async-subagents/agents/ui-qa/backends/tui.mjs`
- `external/pi-tools-suite/src/async-subagents/agents/ui-qa/browser/scripts/browser-qa-runner.mjs`

## Verification

- `node --import tsx --test tests/node-version.test.ts`
- `npm run check`
- `npm run smoke-test`
- `npm run smoke-test:cli`
- `npm run test:tools-suite` with an isolated `HOME` when reproducing CI defaults locally
- `git diff --check`

