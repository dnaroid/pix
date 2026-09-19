# GitHub Release distribution

## Scope and version

Pix ships standalone Node runtime payloads in portable TUI archives and Tauri
Desktop installers. The two variants share preparation code, not an identical
file inventory: only Desktop includes ACP. GitHub Releases are the only supported
distribution channel; the root package is private and must not be published to npm.
Root `package.json` is the authoritative application version. ACP, Desktop,
Tauri, the Pix Cargo package, and the three npm lockfile root records share it.
`npm version` runs `scripts/release/sync-version.mjs --stage` before creating its
commit/tag; `release:version:check` rejects drift. Releases use stable `vX.Y.Z`
tags. The external tools
suite is not independently version-bumped.

## Payload invariants

- Targets are `linux-x64`, `macos-arm64`, and `windows-x64`. Packaging
  runs natively on each target. Unsupported/cross-host targets fail before output
  cleanup or dependency installation.
- Node is downloaded from the official HTTPS distribution for the exact stable
  version currently selected by the release builder's PATH. The repository does
  not pin that version. The exact filename must appear once in `SHASUMS256.txt`;
  its SHA-256 is verified before extraction. `release.json` records the source
  archive hash and version. This is not a GPG verification or an asset attestation.
- Release preparation removes only the owned compiler outputs (`dist`, and
  `acp/dist` when building Desktop) before compilation. Stale Vosk models and
  obsolete emitted JavaScript must not survive a previous local build. Source
  files and the user's `models/` directory are not deleted.
- Pix uses the actual `npm pack` allowlist and locked production dependencies,
  including required optional platform packages. Desktop additionally installs
  ACP's locked dependencies before conservative deduplication. Development
  node_modules, HOME, credentials and the checkout are never copied into the
  payload. Runtime compilers/loaders such as esbuild and jiti are retained.
- Layout is `pix/runtime/node[.exe]`, `pix/app/{bin,dist,node_modules,...}` and
  (Desktop only) `pix/app/acp/{dist,node_modules,...}`. Preserve the relative relationship between
  ACP, Pix dist and the bundled tools suite. Native addons and dependency license
  files are retained; `DEPENDENCIES.json` inventories shipped package metadata.
- The shell/CMD launcher selects the absolute bundled Node path, prepends its
  directory to PATH for child tools, preserves the caller's working directory,
  forwards arguments, and propagates exit status.
- Standalone means no separately installed Node/npm for Pix itself. Git, project
  toolchains, optional language servers, voice/clipboard helpers and provider
  credentials remain external requirements as applicable.

## Payload optimization and size gates

Preparation writes the TUI variant to `.artifacts/releases/<target>/pix` and the
Desktop variant to `.artifacts/releases/<target>/desktop/pix`. Their `release.json`
uses format 2 and declares `variant: tui` or `desktop`. `--tui-only` skips building
and installing ACP entirely. The Desktop wrapper refuses a TUI or stale payload.

Pruning is restricted to known native package families (`@esbuild/*`,
`@lydell/node-pty-*`, and `@mariozechner/clipboard-*`) and Pi TUI's Darwin
modifier prebuilds. Keep the actual target, macOS universal clipboard fallback,
and glibc clipboard builds for the Linux target. Never infer removals from
arbitrary filenames containing OS names. Missing target esbuild versions fail
before pruning; smoke executes every remaining esbuild instance to prove native
resolution after relocation. Debug JavaScript/declaration source maps are removed;
runtime TypeScript, declarations, WASM, data, documentation and licenses stay.

Only top-level ACP packages whose files, executable modes and complete declared
dependency graphs match their parent installation can be removed. Graph comparison
includes optional/peer dependencies, nested shrinkwrapped packages and cycles.
Same package name/version is not sufficient. Different contents or dependency
contexts remain isolated. Unix and Windows npm bin shims are repointed before
removal; package loading then uses normal parent node_modules resolution. No
directory links, dependency upgrades or lockfile edits are used for deduplication.

`SIZE.json` records logical regular-file bytes/counts and section totals.
`OPTIMIZATIONS.json` records removed platform packages/maps and shared dependencies.
The size budgets in `scripts/release/size-budget.mjs` are 384 MiB for the TUI
payload and 512 MiB for the Desktop backend payload, and 160/240 MiB respectively
for their compressed archives/installers. Limits fail closed, not auto-adjusted
to whatever a build produces. A budget change requires review. The installed
GUI also contains the native host and signing metadata beyond its backend payload.

Audits reject legacy Vosk files, ACP inside TUI, remaining foreign packages,
and dangling/external links. Audits and size gates run before bundling and again
on extracted/installed payloads. CI stores size reports separately as `size-*`
artifacts, excluded from the final `release-*` asset download and release manifest.

### Measured size baseline (2026-09-18)

This is a historical local-build measurement, not a promised size for every OS
or a claim that these files were published. Both measurements used Pix `1.0.50`
on `macos-arm64`, with bundled Node `24.21.0` and Pi SDK `0.85.1`. The packaging
changes were in the working tree based on `0a887c7`; that commit alone does not
contain the implementation. macOS signing was ad-hoc, without notarization.

| Measurement | Before (MiB) | After (MiB) | Reduction |
| --- | ---: | ---: | ---: |
| TUI `pix-tui-1.0.50-macos-arm64.tar.gz` | 395.03 | 72.83 | 81.56% |
| Desktop `pix-desktop-1.0.50-macos-arm64.dmg` | 404.66 | 117.60 | 70.94% |
| Unpacked TUI regular files | 1174.07 | 254.85 | 78.29% |
| Complete Desktop `.app` regular files | 1216.86 | 426.34 | 64.96% |

MiB means 1,048,576 bytes. Downloads are measured by archive file size; unpacked
sizes sum regular-file lengths without following symlinks, not filesystem block
allocation or Finder's reported disk usage. The optimized Desktop backend payload
alone was about 388.8 MiB; the full `.app` additionally includes its native host
and signing metadata. Do not compare its whole-app size to the backend-only budget.

#### Causes of the original oversized packages

The initial shared payload included Desktop ACP in the TUI archive. Two independent
production installs also carried overlapping dependencies in `app/node_modules`
and `app/acp/node_modules`. Nested Pi SDK dependency trees contained esbuild
variants for 26 OS/CPU combinations; off-target esbuild packages alone occupied
about 545.9 MiB across those two trees. A stale
`dist/models/vosk/vosk-model-small-ru-0.22` added about 87.1 MiB even though current
dictation no longer used it. These categories overlap and must not be added as
independent savings. Production-only npm installation did not by itself guarantee
a target-minimal artifact, and compilation over an existing `dist` did not remove
obsolete assets.

The corrected pipeline separates TUI/Desktop inventories, cleans compiler output,
prunes known foreign binaries and debug maps, and conservatively shares equivalent
ACP packages. This run shared 50 packages, saving 12,316,322 bytes (11.75 MiB)
after pruning. It did **not** eliminate every duplicate or collapse all Pi SDK
copies. Further savings must preserve the dependency-context rules above; removing
an entire ACP `node_modules` or every `.ts`/`.wasm` file is not a valid shortcut.

#### Evidence and repeat verification

The optimization run completed `npm run release:build -- macos-arm64` with exit
code 0. Both extracted TUI and the native GUI copied from its read-only mounted
DMG passed isolated smoke checks: bundled Node, native PTY, extensions and retained
esbuild; Desktop also passed ACP initialize/new/close. The recorded regression run
passed 1209 root tests, 25 release tests and workflow actionlint. Historical local
npm-smoke evidence may still exist under `.artifacts`, but npm is no longer a
supported publication channel.
Windows and Linux were not executed in this local optimization run; their support
still requires the corresponding native CI results. Real-certificate
signing/notarization was not tested by the ad-hoc build.

Local evidence was saved in `.artifacts/release-size-comparison.json`,
`.artifacts/size-build.log`, `.artifacts/size-build.exit`,
`.artifacts/size-check.log` and `.artifacts/size-npm-smoke.log`, plus each variant's
`SIZE.json` and `OPTIMIZATIONS.json`. These are generated local evidence, not durable
version-controlled dependencies of this spec; the dated table above preserves the
baseline when artifacts are cleaned. Subsequent measurements must record their own
version, target and signing mode rather than treating this snapshot as current.

To validate a later packaging change on a supported native host, run
`npm run test:release` and `npm run release:build -- <target>`. Compare actual
archive bytes and both payload reports, then retain the successful artifact smoke
results. Use `npm run release:smoke -- <target>` and
`npm run release:smoke:desktop -- <target>` to recheck existing artifacts. Never
raise size budgets or remove smoke assertions merely to make an oversized build pass.

## Desktop runtime boundary

`tauri.release.conf.json` enables bundling and copies the prepared payload to
`pix-runtime/` in application resources. Release builds enable the explicit
`bundled-runtime` Cargo feature. In that mode `BackendRuntime` resolves Node,
ACP, all three host extensions, and the bundled pi-tools-suite extension only
from Tauri's resource directory. Missing
files fail with a reinstall diagnostic: never fall back to a build-time checkout,
system Node or development entry overrides. The inherited Pi-entry override is
removed when starting bundled ACP. Environment updates are child-scoped.

The same resource root contains the Desktop first-run bootstrap helper. The
checksum-verified Node archive contributes both the Node executable and its npm
package; npm stays inside pix-runtime/runtime for explicit app-managed tool
installation and is not exposed as a global prerequisite. See
desktop-first-run-bootstrap.md for credential migration and managed IDX rules.

Without this feature, existing development/watch workflows retain source paths
and explicit `PIX_ACP_*` overrides. The base Tauri config stays unbundled for
those workflows; distributable builds use the release orchestrator, not plain
`tauri build` or `npm run build:desktop`.

macOS release bundles declare a minimum version of 13.5. The release builder
sets `CI=true` for unattended
DMG generation without Finder/AppleScript customization, including local builds.

Backend resolution/spawning stays within the existing blocking-worker boundary.
Generation, pipes, shutdown, and per-window ownership are unchanged. The packaged
`--release-smoke-test` diagnostic requires the offline, isolated harness and
performs verification on a worker thread after native Tauri/WebView setup. The
native host exits with a dedicated success code only after backend verification;
the smoke does not depend on GUI stdout being attached on Windows, and a normal
GUI exit cannot be mistaken for verified release-smoke success.

## Artifacts, gates and publishing

The native matrix produces eleven build assets. Three of those are updater `.sig`
sidecars used only inside CI to populate the `signature` fields in `latest.json`;
they are not public GitHub Release downloads and are not listed in `SHA256SUMS`.
The eight public build assets are three TUI archives, one macOS DMG, one macOS
`.app.tar.gz` updater bundle, one Windows NSIS EXE, and Linux AppImage and DEB.
The final publish job rejects missing/unexpected build inputs, generates
`latest.json` from the internal signatures, then hashes only public assets into an
alphabetically ordered `SHA256SUMS`. A complete updater-capable public GitHub
Release therefore contains ten files: eight build/updater assets, `latest.json`,
and `SHA256SUMS`.

`check.yml` owns PR/master correctness checks and never runs on release tags.
`publish.yml` is release-only. A lightweight `release-contract` job validates
release tests and version/tag alignment, then `build-release` runs the three native
targets. Each runner prepares, packages, audits and smoke-tests its real artifacts
before upload. `github-release` waits only for the native release matrix, has the
only `contents: write` permission, validates the tag/repository, creates a draft,
uploads the complete verified asset set, then publishes it as the stable GitHub
Latest release. Failed/incomplete matrices remain non-public. Reruns may replace
draft assets but never published assets. Manual dispatch produces Actions artifacts
but cannot create a GitHub Release. Draft discovery retries briefly after create/edit
because GitHub's release listing is eventually consistent. There is no npm publication
gate or registry dependency.

## Signing and updates

macOS payload Mach-O files are signed inside-out before archiving/bundling. With
no identity they are ad-hoc signed. The embedded Node executable alone receives
Node-specific JIT/native-addon entitlements; the GUI uses separate entitlements.
Optional Apple Developer ID and notarization credentials and Windows PFX signing
credentials are supplied as Actions secrets, imported into temporary runner
stores, and cleaned with `always()` steps. They are never embedded in artifacts.
Absent certificates do not imply trusted OS signing or warning-free installation.

Desktop update signing is a separate trust boundary from Apple Developer ID or
Windows Authenticode signing. `createUpdaterArtifacts` is enabled for release
builds. Tauri signs updater artifacts with the private key supplied only through
`TAURI_SIGNING_PRIVATE_KEY` (or a local ignored key path); the corresponding
public key is embedded in `tauri.release.conf.json`. `latest.json` references the
published GitHub Release assets and embeds their generated signatures for
`linux-x86_64`, `windows-x86_64` and `darwin-aarch64`; separate `.sig` downloads
are intentionally omitted. Losing or replacing the
private updater key without a migration path breaks update continuity for already
installed Desktop clients. The private key must never be committed.

`.pix-portable.json` marks a release installation. Presence, even with damaged
JSON, disables package-manager self-mutation. A valid format-2 marker additionally
identifies `variant` and native `target`. npm installs retain their existing npm
update/ABI-alignment behavior; `--force` on a release installation never mutates
global Pix/Pi packages. Settings and sessions stay in the user profile.

### Portable TUI updater

`/update` inside the TUI remains a non-mutating check. `pix update --check` does
the same from a shell. `pix update` on a valid portable TUI installation fetches
the latest stable GitHub Release, selects the exact target archive, downloads it
and `SHA256SUMS` with bounded byte counts, and requires exactly one matching
SHA-256 entry. It never trusts a filename substring or npm metadata.

The updater extracts into a temporary directory before touching the installation.
ZIP extraction rejects absolute/traversal paths, backslashes, symlinks, and
unsupported entry types. Tar extraction disallows preserved outside paths. The
staged `release.json` and `.pix-portable.json` must match version, target, and TUI
variant; all symlinks must resolve inside the staged tree. The exact bundled Node
then runs the staged `verify.mjs` in an isolated offline profile, covering native
PTY, extensions, and retained esbuild binaries.

Only after verification is the tree copied to a sibling directory on the same
filesystem. A detached helper, running from a temporary copy of the old bundled
Node, waits for the invoking `pix update` process to exit. It renames the current
installation to a sibling backup and the staged tree into the original path. If
the second rename fails, it restores the backup. A successful swap deletes the
backup and schedules cleanup of the temporary helper. Failures before the swap
leave the current installation untouched. Desktop-marked payloads refuse this
CLI replacement path and direct the user to the native updater.

### Desktop updater

Packaged production Desktop builds use Tauri Updater and check the static
`latest.json` endpoint on startup. Development/watch builds do not run the update
check. When a newer signed release exists, the UI shows a dismissible update
banner; installation starts only after the user clicks **Update** and exposes
download progress. Signature verification is performed by Tauri before install.
Windows uses passive NSIS installation and may restart after the installer is
launched. macOS/Linux expose **Restart** after replacement and relaunch through
the process plugin. Failed checks or installs are retryable and never fall back to
npm, ACP, the source checkout, or the portable-TUI replacement code.

The updater is release-gated at both layers. Native Tauri registers the updater
plugin only when the `bundled-runtime` Cargo feature is enabled, so ordinary
development/debug bundles do not require a `plugins.updater` configuration.
The release orchestrator also exports `VITE_PIX_DESKTOP_UPDATER=1` while Tauri
builds the production frontend; without that explicit build flag the WebView
does not start an updater check. This keeps `watch:all` and `tauri dev` from
initializing release-only updater state while preserving updater behavior in
official release artifacts.

## Verification

`test:release` covers targets, checksums, complete-asset gates, version propagation,
published-release protection, stale output cleanup, platform filtering, conservative
dependency sharing, bin shims, and strict size/content gates.
`tests/release-update.test.ts` covers corrupt portable markers, no npm mutation
under `node_modules`, force behavior, stable GitHub metadata, exact asset/checksum
selection, TUI/Desktop updater separation, and swap rollback. Desktop updater
tests cover progress, install/restart, duplicate-install suppression, failure UX,
and stale completion after disposal. Release packaging tests cover the exact
signed updater asset set and generated three-platform `latest.json`. Rust
`backend_runtime` tests cover relocation, missing resources and development
overrides.

Every built archive is extracted outside the checkout into paths with spaces.
The smoke harness isolates the user profile, allowlists only OS/session environment
variables (no provider/signing credentials), removes development Node/npm paths,
adds a failing system-Node sentinel, invokes the real launcher, and runs the exact pinned
bundled Node. It loads native clipboard/PTY dependencies (PTY execution asserts
explicit output), bundled JS/TS extensions and every retained esbuild binary. The
esbuild probe reads the generated `DEPENDENCIES.json` inventory instead of recursively
walking the full dependency tree, avoiding pathological Windows filesystem cost.
Desktop
additionally runs real ACP initialize/new/close without a model request; TUI
asserts that ACP is absent. GUI checks use an app copied from a read-only mounted DMG, extracted DEB/AppImage
or a temporary NSIS installation, and boot the native application diagnostic.
Linux checks the DEB payload directly; for the AppImage it intentionally lets the
native Tauri host resolve `resource_dir()` from the extracted AppDir instead of
hardcoding an AppImage-internal resource path. The DEB smoke likewise discovers
the unique installed `pix-runtime/release.json` instead of assuming a particular
Tauri Linux resource directory layout. Extracted AppImage native smoke launches
its `AppRun` entrypoint rather than the inner executable so linuxdeploy's library
paths and WebKit helper-process environment are preserved.

The copied `verify.mjs` is a one-shot verifier. After all assertions (and Desktop
ACP shutdown) succeed and it prints `PIX_RELEASE_RUNTIME_OK`, it exits explicitly.
This avoids native dependency handles keeping Windows Node alive after successful
verification; the explicit exit is never reached on an assertion/RPC failure.
The native check must produce the backend completion marker, not merely exit
successfully. macOS executable paths are canonicalized rather than weakening
Tauri's protection against symlink-based resource resolution.
All process ceilings are deadlock safeguards, never speed assertions. Cross-OS
support is verified by the native CI jobs, not inferred from a successful macOS
build. Signing with real certificates still requires a credentialed release run.
The generic release subprocess ceiling remains 20 minutes, while the single Tauri
Desktop packaging subprocess gets a 35-minute ceiling because a cold Windows
Rust build plus NSIS generation can legitimately exceed 20 minutes. The
GitHub native job retains its independent 60-minute hard ceiling.

Windows publishes only the NSIS installer. MSI is intentionally omitted because
the signed Tauri updater feed and native smoke both use NSIS; carrying a second
installer adds several minutes of packaging time without adding a supported
update path. Windows NSIS smoke passes encoded installer/destination paths in the
PowerShell command itself rather than through inherited environment variables.

## Implementation

- `scripts/release/`: preparation, Node downloads, signing, installers, smoke and publication.
- `.github/workflows/check.yml`: PR/master correctness matrix.
- `.github/workflows/publish.yml`: release contract, native matrix and stable Release publication.
- `desktop/src-tauri/src/backend_runtime.rs`, `release_smoke.rs`, `lib.rs` and release config: resource-backed host.
- `src/app/cli/release-update.ts`, `portable-update.ts`,
  `portable-update-helper.ts`, `update.ts`, TUI command actions and ACP update
  report: distribution-aware checks and safe portable replacement.
- `desktop/src/app/desktop-updater.svelte.ts`, `DesktopUpdateBanner.svelte`, the
  Tauri updater/process plugins and release config: signed native GUI updates.
- `scripts/release/test/packaging.test.mjs`, `tests/release-update.test.ts`, Rust module tests: deterministic guards.
- `scripts/release/{prune,dedupe,payload-files,size-budget}.mjs` and
  `scripts/release/test/optimization.test.mjs`: bounded runtime inventory and size regressions.
