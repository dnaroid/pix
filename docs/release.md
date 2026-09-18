# Release and update verification

Use this checklist before publishing `pi-ui-extend` so installs work on macOS, Linux, and Windows and the `pi-tools-suite` extension payload is included.

## Downloadable TUI and Desktop releases

One stable `vX.Y.Z` tag produces npm publication and a **draft GitHub Release**
containing portable TUI and Desktop installers. The contract is in
[`specs/release-distribution.md`](../specs/release-distribution.md).

| Target | TUI | Desktop |
| --- | --- | --- |
| Windows x64 | `.zip` with `pix.cmd` | NSIS `-setup.exe` and `.msi` |
| macOS Apple Silicon | `.tar.gz` with `pix` | `.dmg` |
| macOS Intel | `.tar.gz` with `pix` | `.dmg` |
| Linux x64 | `.tar.gz` with `pix` | `.AppImage` and `.deb` |

Each download contains its own pinned Node.js and dependencies. Users do not need
Node/npm to launch Pix. Keep the complete TUI directory together and run its
launcher from a terminal; add that directory to PATH or symlink `pix` on Unix.
Desktop includes ACP and does not require an npm-installed Pix. Git, shells,
project runtimes, optional helpers and provider credentials remain separate.
macOS release packages require 13.5 or newer, matching the bundled Node 24 binary.
Linux bundles are built on Ubuntu 22.04; do not advertise support for older
glibc/WebKit environments without running additional compatibility tests.

### Local build

Select a supported Node on PATH (`.node-version` is the CI/build pin), install
Rust and the platform's [Tauri build prerequisites](https://v2.tauri.app/start/prerequisites/), then run:

```bash
npm ci --ignore-scripts
npm ci --prefix acp --ignore-scripts
npm ci --prefix desktop --ignore-scripts
npm run release:build
# Or specify this machine's target:
npm run release:build -- macos-arm64
# Only the portable TUI archive:
npm run release:build -- macos-arm64 --tui-only
```

Use the corresponding native machine/runner for each target. Cross-host packaging
is rejected because native modules must match both CPU and OS. Output is under
`.artifacts/releases/<target>/assets/`. Builds test the real unpacked package and
the relocated/installed GUI, including an app copied from a mounted read-only DMG.
The release builder sets `CI=true` even locally so DMG creation does not need Finder
automation permissions. Development commands (`dev:desktop`, `watch:all`,
`build:desktop`) remain separate and do not make distributable bundles.

To iterate on the Desktop wrapper after preparing its runtime, use
`npm run release:build:desktop -- <target>`; rebuild the full release after any
Pix/ACP/dependency change. `release:smoke` and `release:smoke:desktop` rerun checks
against already built artifacts. These harnesses create temporary user profiles;
do not invoke `verify.mjs` or the native diagnostic directly with your real HOME.

### Package contents and size checks

The TUI archive includes Pix and its Node runtime, **not ACP**. The Desktop
runtime additionally includes ACP. Preparation cleans generated `dist` directories
before compilation so old emitted files or Vosk models cannot leak into a release;
it does not delete source files or the user's `models/` directory.

The packager removes foreign esbuild/PTY/clipboard variants and debug source maps,
then shares only ACP packages proven equivalent to the parent installation by
file content and dependency graph. Different dependency versions/contexts remain
isolated. Runtime TypeScript, declarations, native binaries for this target,
WASM and license files are preserved.

Inspect `.artifacts/releases/<target>/pix/SIZE.json` for TUI and
`.artifacts/releases/<target>/desktop/pix/SIZE.json` for the Desktop backend.
Adjacent `OPTIMIZATIONS.json` reports explain the pruning and sharing decisions.
Sizes count regular-file bytes, not filesystem block allocation. The native
Desktop host and signing metadata are additional to its backend payload.

Builds fail above these budgets: TUI 384 MiB unpacked / 160 MiB download;
Desktop backend 512 MiB unpacked / 240 MiB installer. The limits live in
`scripts/release/size-budget.mjs`; review dependency growth before changing them.
CI also uploads `size-<target>` report artifacts separately from release assets.
Smoke tests execute native esbuild, PTY and extension loading after unpacking,
and additionally exercise ACP and the native application for Desktop.

### CI and publishing

The `Publish` workflow uses native Ubuntu 22.04 x64, macOS 15 ARM64, macOS 15 Intel
and Windows 2022 x64 runners. `Actions → Publish → Run workflow` builds and tests
all packages without publishing anything. The ten installers/archives are
available as four Actions artifacts. On a version-tag push, the final job waits
for the full native matrix and npm publication, validates the complete set,
adds `SHA256SUMS`, and uploads everything to a draft release. Only then review
the release notes/signing status and click **Publish release** in GitHub.

The draft is intentional: an unsigned or incomplete first build must not silently
become the public latest version. Reruns can replace draft assets, but the release
script refuses to overwrite published assets. Publish a new version for fixes.
Checksums detect damaged downloads; they do not replace trusted code signatures.

### Optional signing secrets

Without signing secrets, macOS builds use ad-hoc signatures and Windows installers
are unsigned. Such builds are suitable for testing but may trigger OS warnings.
Trusted signing/notarization cannot be configured without the maintainer's keys.

For macOS, configure repository Actions secrets `APPLE_CERTIFICATE` (base64 P12),
`APPLE_CERTIFICATE_PASSWORD`, and `APPLE_SIGNING_IDENTITY` (Developer ID Application).
For Tauri notarization also set `APPLE_ID`, `APPLE_PASSWORD` (app-specific password)
and `APPLE_TEAM_ID`. The workflow imports the certificate into a temporary keychain,
signs nested runtime binaries before the app, and cleans the keychain afterwards.
The Node executable has separate JIT/native-addon entitlements. An ad-hoc signature
is not Developer ID signing. The TUI tarball is not a notarized installer; test its
download/quarantine UX separately before promising warning-free installation.

For Windows, configure `WINDOWS_CERTIFICATE` (base64 PFX) and
`WINDOWS_CERTIFICATE_PASSWORD`. The workflow imports it into the runner's user
certificate store, passes its thumbprint to Tauri and removes it afterwards.
Hardware-backed/cloud signing requires adapting that signing step to the selected
provider; the PFX path does not claim to cover every certificate provider.

Keep keys out of the repository and out of release files. Official references:
[macOS signing](https://v2.tauri.app/distribute/sign/macos/),
[Windows signing](https://v2.tauri.app/distribute/sign/windows/), and
[Tauri resource bundling](https://v2.tauri.app/develop/resources/).

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
- npm package smoke tests run the full payload/tarball test on Ubuntu and a smaller pack/install/CLI check on Windows. Portable/Tauri release artifacts additionally run smoke tests on all four native targets.

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

The root `package.json` version is authoritative. Its npm `version` hook synchronizes
ACP, Desktop, Tauri, Cargo and lockfile versions and stages them before npm creates
the release commit/tag. `npm run release:version:check` detects drift; use
`npm run release:version` to repair manifests after a manual root-version edit.
Only stable `X.Y.Z` versions within MSI bounds are supported by this release path.
Do not bump `external/pi-tools-suite/package.json` unless publishing the suite separately.

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

Portable TUI and packaged Desktop detect their `.pix-portable.json` marker and
check stable GitHub Releases instead of npm. `/update`, `pix update --check`, and
the Desktop report point to a complete replacement download. `pix update` or
`--force` cannot modify global npm/Pi packages for these installs. Close Pix before
replacing the complete package; sessions/settings remain in the user profile.
Automatic binary replacement/Tauri Updater is not enabled in this first release
pipeline. The following package-manager behavior applies only to npm installs.

- `/update` inside Pix performs a non-mutating Pix update check and reports whether the global Pi package in the same package-manager prefix matches Pix's pinned Pi SDK version.
- `pix update --check` performs the same compatibility check without a TTY and never mutates either package.
- `pix update` first updates a package-manager installation of Pix when needed, then installs the global `@earendil-works/pi-coding-agent` at the exact version pinned by the resulting Pix package. This keeps the shared `pi-tools-suite` host ABI aligned. The next Pix startup refreshes the user extension link.
- `pix update --force` reinstalls both Pix and its matching global Pi version.
- If the Pix update fails, Pi is not changed. If Pix is updated successfully (or is already current) but the Pi install fails, the command exits unsuccessfully and prints the exact Pi install command for recovery.
- Source checkouts are intentionally not self-mutated; update them with `git pull`, `npm install --ignore-scripts`, `npm run build:pix`, and `npm run link:pix`.
- A `pi` executable installed under a different package-manager prefix is outside `pix update`'s scope and must be updated separately.

Update checks respect `PI_OFFLINE=1`, `PI_SKIP_VERSION_CHECK=1`, and `PIX_SKIP_VERSION_CHECK=1`.
