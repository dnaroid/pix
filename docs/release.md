# Release and update verification

Use this checklist before publishing `pi-ui-extend` so installs work on macOS, Linux, and Windows and the `pi-tools-suite` extension payload is included.

## Local release check

```bash
npm install --ignore-scripts
npm run release:check
npm run smoke-test
```

`release:check` runs type checking, the test suite, a production build, and `npm pack --dry-run`.
`smoke-test` packs the real tarball, installs it into an isolated temp directory, checks the bundled files, and runs non-interactive `pix` commands from the installed package.

## CI regression guardrails

The normative CI invariants are recorded in [`specs/ci-release.md`](../specs/ci-release.md). This section is the operational checklist for release work.

The GitHub Actions release workflow has two different responsibilities and they should stay separate:

- `build-and-test` runs on Ubuntu, macOS, and Windows. This is the cross-platform correctness gate: type checks, unit/integration tests, platform-specific host checks, and the Pix build belong here.
- Package smoke tests validate the artifact a user actually installs. Run the full payload/tarball smoke test on Ubuntu, and a smaller pack/install/CLI sanity check on Windows. A separate macOS package smoke job is unnecessary unless packaging gains macOS-specific behavior.

Keep CI tests deterministic across runner speed and operating systems:

- Assert explicit byte/count/state thresholds instead of assuming a background producer will do enough work within a short wall-clock interval. For example, a truncation test should write a fixed amount greater than the limit rather than write repeatedly for 300 ms and assume the runner will exceed the limit.
- Use timers only when timeout behavior itself is the contract. Do not use elapsed time as a proxy for produced output, process progress, or cleanup completion.
- When a test needs asynchronous process teardown, wait for an observable owned-process condition rather than relying on a short sleep.
- Run configuration-sensitive suite checks with an isolated `HOME` when reproducing CI locally. User-level Pix/pi-tools-suite config can intentionally change DCP and other opt-in behavior and must not be mistaken for a CI regression.

Windows process tests have additional invariants:

- `@lydell/node-pty` on Windows does not support POSIX signal arguments to `kill`; terminate an owned Windows PTY with signal-less `kill()` and release its ConPTY resources.
- Browser/process cleanup must stay ownership-scoped. When a PowerShell helper discovers descendants, it must not select or terminate itself; kill owned child roots recursively and verify cleanup before returning.
- Treat CRLF/LF differences as presentation differences unless line endings are the behavior under test.

Package smoke assertions should check stable package contracts. If a bundled guide title, required payload path, CLI entry point, or other intentionally asserted artifact changes, update the corresponding smoke assertion in the same change. Do not remove the smoke test merely because ordinary source tests are green: source tests do not prove that `npm pack` contains an installable, runnable artifact.

Current implementation:

- `.github/workflows/publish.yml` owns the CI matrix and release gates.
- `scripts/smoke-test-package.sh` is the full packed-artifact/payload smoke test.
- `scripts/smoke-test-package-cli.mjs` is the cross-platform pack/install/CLI sanity check used on Windows.

## Publish a new npm version

Pix uses the same release style as `indexer-cli`: a local command bumps the version, smoke-tests the tarball, then pushes the release commit and tag. GitHub Actions publishes the tag to npm using npm trusted publishing (GitHub OIDC), so the publish job does not require a long-lived `NPM_TOKEN` secret.

Release commands:

```bash
npm run publish-npm              # patch release
npm run publish-npm -- minor      # minor release
npm run publish-npm -- major      # major release
npm run publish-npm -- 0.2.0      # exact version
```

The command requires a clean working tree on `master`, pulls latest from `origin/master`, runs `release:check`, runs `npm version`, runs the tarball smoke test, then pushes the branch and `v*` tag. The tag workflow verifies that `package.json` matches the tag before `npm publish --access public`.

Only the root `package.json` version is bumped for Pix releases. Do not bump `external/pi-tools-suite/package.json` unless publishing the suite as a separate package.

## Tarball smoke test

From a clean temporary directory:

```bash
npm pack /path/to/pi-ui-extend
npm install -g ./pi-ui-extend-*.tgz --ignore-scripts
pix update --check
```

Confirm the dry-run/pack output contains:

- `bin/pix.mjs`
- `dist/**`
- `extensions/**`
- `external/pi-tools-suite/**`
- `README.md` and `docs/release.md`

## External suite checks

`external/pi-tools-suite` is a real checked-in package directory, not a symlink. Pix links it into the standard user extension location (`~/.pi/agent/extensions/pi-tools-suite` on macOS/Linux) before creating SDK services. The normal test suite verifies both the renderer-owned bundled extensions and the suite installer/link behavior.

When Bun is available, also run the suite's own checks:

```bash
npm --prefix external/pi-tools-suite test
```

Some modules have optional runtime dependencies or host services:

- `web-search` requires a local Ollama web-search/web-fetch API.
- `terminal-bell` uses optional platform notification helpers when present.
- `async-subagents` writes run state under the workspace `.pi/subagents/` directory.

## Update UX

- `/update` inside Pix performs a non-mutating Pix update check and reports whether the global Pi package in the same package-manager prefix matches Pix's pinned Pi SDK version.
- `pix update --check` performs the same compatibility check without a TTY and never mutates either package.
- `pix update` first updates a package-manager installation of Pix when needed, then installs the global `@earendil-works/pi-coding-agent` at the exact version pinned by the resulting Pix package. This keeps the shared `pi-tools-suite` host ABI aligned. The next Pix startup refreshes the user extension link.
- `pix update --force` reinstalls both Pix and its matching global Pi version.
- If the Pix update fails, Pi is not changed. If Pix is updated successfully (or is already current) but the Pi install fails, the command exits unsuccessfully and prints the exact Pi install command for recovery.
- Source checkouts are intentionally not self-mutated; update them with `git pull`, `npm install --ignore-scripts`, `npm run build:pix`, and `npm run link:pix`.
- A `pi` executable installed under a different package-manager prefix is outside `pix update`'s scope and must be updated separately.

Update checks respect `PI_OFFLINE=1`, `PI_SKIP_VERSION_CHECK=1`, and `PIX_SKIP_VERSION_CHECK=1`.
