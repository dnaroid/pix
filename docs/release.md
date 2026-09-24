# Release and update verification

Use this checklist before publishing a Pix GitHub Release so installs work on macOS, Linux, and Windows and the `pi-tools-suite` extension payload is included.

**Desktop support is currently macOS only.** Windows/Linux Desktop packaging
remains in the tooling but is not a supported product or a current Desktop
validation requirement. TUI support on those platforms is unchanged.

## Downloadable TUI and Desktop releases

One stable `vX.Y.Z` tag produces a **published GitHub Release** containing portable
TUI and Desktop installers. The contract is in
[`specs/release-distribution.md`](../specs/release-distribution.md).

| Target | TUI | Desktop |
| --- | --- | --- |
| Windows x64 | `.zip` with `pix.cmd` | Legacy tooling only; unsupported |
| macOS Apple Silicon | `.tar.gz` with `pix` | `.dmg` |
| Linux x64 | `.tar.gz` with `pix` | Legacy tooling only; unsupported |

Each download contains its own Node.js runtime and dependencies. The bundled
runtime version matches the Node selected from `PATH` on that native release
builder. Users do not need Node/npm to launch Pix. Keep the complete TUI directory together and run its
launcher from a terminal; add that directory to PATH or symlink `pix` on Unix.
Desktop includes ACP and does not require an npm-installed Pix. Git, shells,
project runtimes, optional helpers and provider credentials remain separate.
macOS release packages require 13.5 or newer.
Linux bundles are built on Ubuntu 22.04; do not advertise support for older
glibc/WebKit environments without running additional compatibility tests.

### Local build

Select a supported Node and npm on PATH, install Rust and the platform's
[Tauri build prerequisites](https://v2.tauri.app/start/prerequisites/), then run:

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

After changing Node major versions, remove every repository `node_modules`
tree and rerun the corresponding `npm ci` commands before building. Native
addons must be rebuilt for the active Node ABI.

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

Desktop release builds also require the Tauri updater signing private key. CI
reads it from the `TAURI_SIGNING_PRIVATE_KEY` repository secret. A local release
can provide that environment variable or `TAURI_SIGNING_PRIVATE_KEY_PATH`; the
release helper also recognizes the ignored local path
`.artifacts/release-signing/pix-updater.key`. Never commit the private key, and
keep a durable secure backup. This checkout's rotated key is stored at
`~/.config/pix/release-signing/pix-updater.key` (owner-only directory and files);
use `TAURI_SIGNING_PRIVATE_KEY_PATH="$HOME/.config/pix/release-signing/pix-updater.key"`
for local builds. Keep a separate, securely backed-up copy outside build artifacts
and the repository; if this key is lost, the public key and Actions secret cannot
recover it. Do not print the private key or include it in logs or artifacts.

Prefer keeping the durable key outside `.artifacts` and supplying its path via
`TAURI_SIGNING_PRIVATE_KEY_PATH`: deleting build artifacts must not delete your
only key copy. The rotated key was generated with an empty password for unattended
signing: leave `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` unset (or empty) locally and in
CI; a nonempty password will not unlock this key. Protect the private key via
filesystem permissions and a secure backup instead.

The old updater signing key was lost. Its prior distribution is uncertain. On
2026-09-24 the committed Desktop updater public key was rotated; any clients
already installed with the **old** public key cannot verify updates signed by
this replacement. They must manually download and reinstall a new Desktop release
to establish the new trust root; no in-app migration or automatic update from
old-trust installs is promised. The current version remains **2.0.14**; increment
the version before shipping any new updater-enabled Desktop release so installed
clients can detect it. The new public key's SHA-256 fingerprint (of the `.pub`
file's exact bytes) is
`05f3494ed57d62bfcdcf0311bb01ab9cc0074bf5e08cb7fd75fc7b4df107f439`.

**Manual CI action required:** replace the repository's `TAURI_SIGNING_PRIVATE_KEY`
secret with the *new* private key before running release CI or pushing a release
tag; this command is for the maintainer to run, not a completed secret update:

```bash
gh secret set TAURI_SIGNING_PRIVATE_KEY < "$HOME/.config/pix/release-signing/pix-updater.key"
```

Do not rotate again merely because CI has not yet been updated; it would strand
clients that trust this newly committed public key.

### Package contents and size checks

The TUI archive includes Pix and its Node runtime, **not ACP**. The Desktop
runtime additionally includes ACP. Preparation cleans generated `dist` directories
before compilation so old emitted files or Vosk models cannot leak into a release;
it does not delete source files or the user's `models/` directory.

The packager removes foreign esbuild/PTY/clipboard variants and debug source maps,
then shares equivalent nested TUI/Desktop packages and top-level ACP packages
only with their first Node ancestor fallback, after file/mode and complete
dependency-graph comparison. Differing versions, dependency contexts and nearer
shadowing packages remain isolated. The `shared` optimization report applies to
both variants and lists each removed package's original and fallback path.
Compatible root/ACP transitive lock resolutions can be aligned as a separate
dependency change, after checking consumer ranges and clean installs. Preparation
never edits locks or weakens graph equivalence to increase sharing.
Runtime TypeScript, declarations, native binaries for this target,
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

The `Release` workflow uses native Ubuntu 22.04 x64, macOS 15 ARM64 and Windows
2022 x64 runners. `Actions → Release → Run workflow` builds and tests all packages
without publishing anything. The seven user-facing installers/archives are
available as three Actions artifacts. On a version-tag push, the final job waits
for the full native matrix, validates the complete set, adds `SHA256SUMS`, uploads
everything to a temporary draft, and only after the complete upload succeeds
publishes it as the public **Latest** release. A failed or incomplete matrix never
becomes public. The release script refuses to overwrite an already published
release; publish a new version for fixes.
Checksums detect damaged downloads; they do not replace trusted code signatures.
The final release also contains signed Tauri updater artifacts plus `latest.json`;
the latter is generated only after all three native jobs have supplied the exact
expected asset set.

Tauri's generated `.sig` sidecars are CI inputs, not public downloads. Their text
is embedded into `latest.json` for updater verification, while the standalone
`.sig` files are omitted from GitHub Releases and `SHA256SUMS`.

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

Tauri updater signing is independent from those OS identities. Configure
`TAURI_SIGNING_PRIVATE_KEY` with the private minisign-compatible key whose public
half is embedded in `tauri.release.conf.json`. The release matrix emits `.sig`
files for Windows NSIS/Linux AppImage and signed `.app.tar.gz` updater bundles for
both macOS architectures. `latest.json` maps the four Tauri targets to those
files. OS code-signing warnings may still occur when Developer ID/Authenticode
credentials are absent even though the updater signature itself is valid.

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

The GitHub Actions workflows have two different responsibilities and they stay separate:

- `check.yml` runs the cross-platform correctness matrix on pull requests and
  `master` pushes. It does not run on release tags.
- `publish.yml` is release-only: a lightweight release-contract check followed by
  the three native standalone package jobs and, for tag pushes, verified GitHub Release publication.
- Native release smoke remains mandatory because it validates the relocated TUI
  archive and installed Desktop application, not source or npm-package behavior.

Keep CI tests deterministic across runner speed and operating systems:

- Assert explicit byte/count/state thresholds instead of assuming a background producer will do enough work within a short wall-clock interval. For example, a truncation test should write a fixed amount greater than the limit rather than write repeatedly for 300 ms and assume the runner will exceed the limit.
- Use timers only when timeout behavior itself is the contract. Do not use elapsed time as a proxy for produced output, process progress, or cleanup completion.
- When a test needs asynchronous process teardown, wait for an observable owned-process condition rather than relying on a short sleep.
- Run configuration-sensitive suite checks with an isolated `HOME` when reproducing CI locally. User-level Pix/pi-tools-suite config can intentionally change DCP and other opt-in behavior and must not be mistaken for a CI regression.

Windows process tests have additional invariants:

- `@lydell/node-pty` on Windows does not support POSIX signal arguments to `kill`; terminate an owned Windows PTY with signal-less `kill()` and release its ConPTY resources.
- Browser/process cleanup must stay ownership-scoped. When a PowerShell helper discovers descendants, it must not select or terminate itself; kill owned child roots recursively and verify cleanup before returning.
- Treat CRLF/LF differences as presentation differences unless line endings are the behavior under test.

Current implementation:

- `.github/workflows/check.yml` owns PR/master correctness checks.
- `.github/workflows/publish.yml` owns tag/manual release packaging and stable Release publication.
- `scripts/release/smoke.mjs` and `smoke-desktop.mjs` validate the actual standalone artifacts.

## Create a release version

The root `package.json` version remains the authoritative application version even
though Pix is not published to npm. Use `npm version` because its version hook
synchronizes ACP, Desktop, Tauri, Cargo and lockfiles before creating the tag:

```bash
npm version patch -m "chore(release): %s"
# or an exact version
npm version 2.0.2 -m "chore(release): %s"
git push origin master
git push origin v2.0.2
```

The root `package.json` version is authoritative. Its npm `version` hook synchronizes
ACP, Desktop, Tauri, Cargo and lockfile versions and stages them before npm creates
the release commit/tag. `npm run release:version:check` detects drift; use
`npm run release:version` to repair manifests after a manual root-version edit.
Only stable `X.Y.Z` versions are supported by this release path.
Do not bump `external/pi-tools-suite/package.json` unless publishing the suite separately.

`npm pack` is still used internally by `scripts/release/prepare.mjs` to apply the
declared package-file allowlist before installing locked production dependencies
into a standalone payload. It is an implementation detail, not a supported
installation or publication channel. The root package is marked `private` to
prevent accidental registry publication.

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
check stable GitHub Releases instead of npm. `/update` and `pix update --check`
are non-mutating checks. For a portable TUI install, `pix update` downloads the
exact OS/CPU archive and `SHA256SUMS`, verifies the digest, validates and smoke
tests the staged runtime, then schedules a sibling-directory swap after the
updater process exits. The swap keeps a rollback backup until the new tree takes
the original path. A damaged marker disables automatic replacement rather than
falling back to npm.

Packaged Desktop uses Tauri Updater instead of the backend CLI. Production builds
check `latest.json` at startup and show an Update banner when a newer signed
version exists. Clicking Update downloads/verifies/installs it with progress;
macOS/Linux then offer Restart, while Windows lets the passive installer handle
the restart path. Development builds do not perform this check. Desktop and TUI
release updates never mutate global npm/Pi packages. The following package-manager
behavior applies only to npm installs.

- `/update` inside Pix performs a non-mutating Pix update check and reports whether the global Pi package in the same package-manager prefix matches Pix's pinned Pi SDK version.
- `pix update --check` performs the same compatibility check without a TTY and never mutates either package.
- `pix update` first updates a package-manager installation of Pix when needed, then installs the global `@earendil-works/pi-coding-agent` at the exact version pinned by the resulting Pix package. This keeps the shared `pi-tools-suite` host ABI aligned. The next Pix startup refreshes the user extension link.
- `pix update --force` reinstalls both Pix and its matching global Pi version.
- If the Pix update fails, Pi is not changed. If Pix is updated successfully (or is already current) but the Pi install fails, the command exits unsuccessfully and prints the exact Pi install command for recovery.
- Source checkouts are intentionally not self-mutated; update them with `git pull`, `npm install --ignore-scripts`, `npm run build:pix`, and `npm run link:pix`.
- A `pi` executable installed under a different package-manager prefix is outside `pix update`'s scope and must be updated separately.

Update checks respect `PI_OFFLINE=1`, `PI_SKIP_VERSION_CHECK=1`, and `PIX_SKIP_VERSION_CHECK=1`.
